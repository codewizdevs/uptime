'use strict';

// Generic OpenID Connect login (authorization code flow + PKCE).
//
// Protocol work — discovery, state/nonce/PKCE checks, ID token signature and
// claim validation — is delegated to `openid-client`. This module only maps a
// validated identity onto a row in the `users` table:
//
//   1. a user already linked to this (iss, sub)     → that user
//   2. OIDC_AUTO_CREATE (default on)                → new user
//
// Accounts are never linked by email: a local user can set their own email to
// anything, so a matching address proves nothing. Existing local users link
// their account themselves with "Connect SSO" while signed in (linkUser).
//
// Access comes only from the groups claim: OIDC_ADMIN_GROUP /
// OIDC_EDITOR_GROUP / OIDC_VIEWER_GROUP each name a group (or `*` for any
// authenticated user). The highest matching level wins; no match means no
// access. Roles are re-synced on every login. The env super-admin is
// never reachable through OIDC; it stays a password-only break-glass account.

const config = require('../config');
const logger = require('../logger');
const users = require('./users');

const CALLBACK_PATH = '/login/oidc/callback';

let clientLib = null;
let serverConfigPromise = null;

// openid-client v6 is ESM-only; load it lazily from this CommonJS module.
async function lib() {
  if (!clientLib) clientLib = await import('openid-client');
  return clientLib;
}

function redirectUri() {
  return `${config.publicBaseUrl}${CALLBACK_PATH}`;
}

// client_secret_basic with RFC 3986 percent-encoding. openid-client's built-in
// variant form-encodes the credentials (e.g. "-" → "%2D"), and providers that
// don't decode them — PocketID with its UUID client ids — reject the request.
function clientSecretBasic(clientId, clientSecret) {
  const creds = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return (_as, _client, _body, headers) => {
    headers.set('authorization', `Basic ${Buffer.from(creds).toString('base64')}`);
  };
}

// Discovery is cached for the process lifetime. A failure is not cached, so a
// provider that was down at boot is picked up on the next login attempt.
async function serverConfig() {
  if (!serverConfigPromise) {
    serverConfigPromise = (async () => {
      const client = await lib();
      const issuer = new URL(config.oidc.issuer);
      const options = {};
      // checkConfig() refuses http: issuers unless OIDC_ALLOW_HTTP_ISSUER.
      if (issuer.protocol === 'http:' && config.oidc.allowHttpIssuer) {
        options.execute = [client.allowInsecureRequests];
      }
      const discovered = await client.discovery(issuer, config.oidc.clientId, undefined, client.None(), options);
      const meta = discovered.serverMetadata();
      // No client secret → public client (PKCE only). Otherwise use
      // client_secret_basic (the spec default) unless the provider only
      // advertises client_secret_post.
      let auth = client.None();
      let authMethod = 'none';
      if (config.oidc.clientSecret) {
        const supported = meta.token_endpoint_auth_methods_supported || ['client_secret_basic'];
        authMethod = !supported.includes('client_secret_basic') && supported.includes('client_secret_post')
          ? 'client_secret_post'
          : 'client_secret_basic';
        auth = authMethod === 'client_secret_post'
          ? client.ClientSecretPost(config.oidc.clientSecret)
          : clientSecretBasic(config.oidc.clientId, config.oidc.clientSecret);
      }
      const cfg = new client.Configuration(meta, config.oidc.clientId, undefined, auth);
      if (options.execute) client.allowInsecureRequests(cfg);
      logger.info({ issuer: issuer.href, authMethod }, 'oidc.discovery_ok');
      return cfg;
    })().catch((err) => {
      serverConfigPromise = null;
      throw err;
    });
  }
  return serverConfigPromise;
}

// Returns the provider URL to redirect to, plus the per-attempt secrets the
// caller must keep in the session until the callback.
async function beginLogin() {
  const client = await lib();
  const cfg = await serverConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: redirectUri(),
    scope: config.oidc.scopes,
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url: url.href, pending: { codeVerifier, state, nonce, ts: Date.now() } };
}

// Exchange the authorization code and return the merged ID token + userinfo
// claims. Throws on any validation failure.
async function finishLogin(originalUrl, pending) {
  const client = await lib();
  const cfg = await serverConfig();
  // Rebuild the callback URL from PUBLIC_BASE_URL rather than the Host header
  // so it matches the registered redirect URI behind a reverse proxy.
  const currentUrl = new URL(originalUrl, `${config.publicBaseUrl}/`);
  const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: pending.codeVerifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });
  const claims = { ...tokens.claims() };
  // Some providers only put groups/email in the userinfo response.
  if (tokens.access_token && cfg.serverMetadata().userinfo_endpoint) {
    try {
      const info = await client.fetchUserInfo(cfg, tokens.access_token, claims.sub);
      for (const [k, v] of Object.entries(info)) {
        if (claims[k] === undefined) claims[k] = v;
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'oidc.userinfo_failed');
    }
  }
  return claims;
}

// An array claim is used as-is. A string claim is a comma-separated list, so
// group names may contain spaces ("Uptime Admins").
function groupsFromClaims(claims) {
  const raw = claims[config.oidc.groupsClaim];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(',').map((g) => g.trim()).filter(Boolean);
  return [];
}

const ROLE_GROUPS = [
  ['admin', 'adminGroup'],
  ['editor', 'editorGroup'],
  ['viewer', 'viewerGroup'],
];

// Highest role whose configured group matches, or null when none does.
function roleFromClaims(claims) {
  const groups = groupsFromClaims(claims);
  for (const [role, key] of ROLE_GROUPS) {
    const group = config.oidc[key];
    if (group && (group === '*' || groups.includes(group))) return role;
  }
  return null;
}

// Startup check. Throws for configurations that cannot work; warns for ones
// that are valid but risky.
function checkConfig() {
  if (!config.oidc.enabled) return;
  let issuer;
  try { issuer = new URL(config.oidc.issuer); } catch {
    throw new Error(`OIDC_ISSUER is not a valid URL: ${config.oidc.issuer}`);
  }
  if (issuer.protocol === 'http:') {
    if (!config.oidc.allowHttpIssuer) {
      throw new Error('OIDC_ISSUER uses plain http, which sends the authorization code, tokens and client secret unencrypted. Use https, or set OIDC_ALLOW_HTTP_ISSUER=true if the provider is on a trusted internal network.');
    }
    logger.warn({ issuer: issuer.href }, 'oidc.insecure_issuer: OIDC_ISSUER uses plain http; tokens and the client secret travel unencrypted');
  } else if (issuer.protocol !== 'https:') {
    throw new Error(`OIDC_ISSUER must be an https URL: ${config.oidc.issuer}`);
  }
  // The env super-admin is the only password login left when password
  // sign-in is disabled; the default password would make it the weak spot.
  if (config.admin.passIsDefault) {
    if (config.oidc.disablePasswordLogin) {
      throw new Error('OIDC_DISABLE_PASSWORD_LOGIN is set but ADMIN_PASS is unset or "admin". Set a strong ADMIN_PASS for the break-glass account.');
    }
    logger.warn('auth.default_admin_password: ADMIN_PASS is unset or "admin"; set a strong password for the env super-admin');
  }
  if (!ROLE_GROUPS.some(([, key]) => config.oidc[key])) {
    throw new Error('OIDC is enabled but OIDC_ADMIN_GROUP, OIDC_EDITOR_GROUP and OIDC_VIEWER_GROUP are all unset, so nobody could sign in. Set at least one (use * to allow any authenticated user).');
  }
  for (const [role, key] of ROLE_GROUPS) {
    if (config.oidc[key] === '*') {
      logger.warn({ role }, `oidc.wildcard_group: every user the identity provider authenticates can sign in as ${role}`);
    }
  }
}

function identityFromClaims(claims) {
  const iss = claims.iss ? String(claims.iss) : '';
  const sub = claims.sub ? String(claims.sub) : '';
  return { iss, sub };
}

// Resolve (and if allowed, provision) the DB user for a validated identity.
// Returns { user } or { error } with a message safe to show on the login page.
async function resolveUser(claims) {
  const { iss, sub } = identityFromClaims(claims);
  if (!iss || !sub) return { error: 'Identity provider did not return a subject' };
  const role = roleFromClaims(claims);
  if (!role) return { error: 'Your account is not authorised for Uptime', denied: true };

  let user = await users.findByOidcIdentity(iss, sub);
  const how = 'sub';

  if (!user) {
    if (!config.oidc.autoCreate) {
      return { error: 'No account is linked to this identity' };
    }
    const email = typeof claims.email === 'string' ? claims.email.trim() : null;
    try {
      user = await users.createOidcUser({
        iss,
        sub,
        preferredUsername: claims.preferred_username || claims.nickname || claims.name,
        email,
        displayName: claims.name || null,
        role,
      });
    } catch (err) {
      // A concurrent first login for the same identity won the insert
      // (unique index on the identity, or the same derived username).
      const existing = await users.findByOidcIdentity(iss, sub);
      if (!existing) throw err;
      return { user: existing, how: 'sub' };
    }
    logger.info({ userId: user.id, username: user.username, role }, 'oidc.user_created');
    return { user, how: 'created' };
  }

  // A disabled account is refused by the caller; leave it untouched.
  if (user.disabled) return { user, how, roleChange: null };

  let roleChange = null;
  if (user.role !== role) {
    // Never demote the last active DB admin; the provider's groups win
    // everywhere else.
    if (user.role === 'admin' && !user.disabled && (await users.countAdmins()) <= 1) {
      logger.warn({ userId: user.id, username: user.username, to: role }, 'oidc.role_sync_skipped_last_admin');
    } else {
      await users.updateRole(user.id, role);
      roleChange = { from: user.role, to: role };
      logger.info({ userId: user.id, ...roleChange }, 'oidc.role_synced');
      user = await users.getById(user.id);
    }
  }
  return { user, how, roleChange };
}

// "Connect SSO": attach a validated identity to the signed-in local user.
// Both sides are proven in one session — the user is logged in locally and
// has just authenticated at the provider — so no email matching is involved.
// Returns { ok: true } or { error } with a message safe to show.
async function linkUser(userId, claims) {
  const { iss, sub } = identityFromClaims(claims);
  if (!iss || !sub) return { error: 'Identity provider did not return a subject' };
  const user = await users.getById(userId);
  if (!user || user.disabled) return { error: 'Account is not available' };
  if (user.auth_source !== 'local') return { error: 'This account already signs in with single sign-on' };
  if (user.oidc_linked) return { error: 'This account is already connected to single sign-on' };
  if (!roleFromClaims(claims)) return { error: 'Your single sign-on account is not authorised for Uptime' };
  const owner = await users.findByOidcIdentity(iss, sub);
  if (owner) return { error: 'This single sign-on identity is already connected to another account' };
  if (!(await users.linkOidcIdentity(userId, iss, sub))) {
    return { error: 'This single sign-on identity is already connected to another account' };
  }
  logger.info({ userId, username: user.username }, 'oidc.user_linked');
  return { ok: true };
}

module.exports = {
  CALLBACK_PATH,
  redirectUri,
  beginLogin,
  finishLogin,
  resolveUser,
  linkUser,
  roleFromClaims,
  groupsFromClaims,
  checkConfig,
};
