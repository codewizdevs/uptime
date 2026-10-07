'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const toBool = (v, fallback = false) => {
  if (v == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const toInt = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

function oidcGroup(raw) {
  const v = String(raw || '').trim();
  return v.toLowerCase() === 'none' ? '' : v;
}

const driverRaw = String(process.env.DB_DRIVER || 'sqlite').toLowerCase();
const driver = driverRaw === 'mysql' ? 'mysql' : 'sqlite';

const resolveOptionalPath = (value) => {
  if (!value || !String(value).trim()) return null;
  const v = String(value).trim();
  return path.isAbsolute(v) ? v : path.resolve(__dirname, '..', v);
};

const sqliteFile = process.env.SQLITE_PATH
  ? (path.isAbsolute(process.env.SQLITE_PATH)
      ? process.env.SQLITE_PATH
      : path.resolve(__dirname, '..', process.env.SQLITE_PATH))
  : path.resolve(__dirname, '..', 'data', 'uptime.sqlite');

const config = {
  port: toInt(process.env.PORT, 3000),
  // Falling back to a random per-boot secret (instead of a hardcoded string)
  // means unset SESSION_SECRET can never be exploited to forge cookies —
  // the tradeoff is sessions reset on restart, which the boot warning explains.
  sessionSecret: process.env.SESSION_SECRET
    || require('crypto').randomBytes(32).toString('hex'),
  sessionSecretGenerated: !process.env.SESSION_SECRET,
  appDebug: toBool(process.env.APP_DEBUG, false),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || `http://localhost:${toInt(process.env.PORT, 3000)}`,
  db: {
    driver,
    host: process.env.DB_HOST || '127.0.0.1',
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'uptime',
    sqlitePath: sqliteFile,
  },
  admin: {
    user: process.env.ADMIN_USER || 'admin',
    pass: process.env.ADMIN_PASS || 'admin',
    passIsDefault: !process.env.ADMIN_PASS || process.env.ADMIN_PASS === 'admin',
  },
  // Generic OpenID Connect single sign-on (PocketID, Authelia, Authentik,
  // Keycloak, …). Disabled unless OIDC_ISSUER and OIDC_CLIENT_ID are set.
  oidc: {
    enabled: !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID),
    issuer: (process.env.OIDC_ISSUER || '').trim(),
    clientId: (process.env.OIDC_CLIENT_ID || '').trim(),
    clientSecret: (process.env.OIDC_CLIENT_SECRET || '').trim(),
    scopes: (process.env.OIDC_SCOPES || 'openid profile email groups').trim(),
    buttonLabel: (process.env.OIDC_BUTTON_LABEL || 'Sign in with SSO').trim(),
    groupsClaim: (process.env.OIDC_GROUPS_CLAIM || 'groups').trim(),
    // Group per role: a group name, `*` for any authenticated user, or
    // empty/`none` to never grant that role through SSO.
    adminGroup: oidcGroup(process.env.OIDC_ADMIN_GROUP),
    editorGroup: oidcGroup(process.env.OIDC_EDITOR_GROUP),
    viewerGroup: oidcGroup(process.env.OIDC_VIEWER_GROUP),
    autoCreate: toBool(process.env.OIDC_AUTO_CREATE, true),
    disablePasswordLogin: toBool(process.env.OIDC_DISABLE_PASSWORD_LOGIN, false),
    // Plain-http issuers send the code, tokens and client secret unencrypted;
    // they're refused unless explicitly allowed (e.g. a Docker-internal host).
    allowHttpIssuer: toBool(process.env.OIDC_ALLOW_HTTP_ISSUER, false),
  },
  retention: {
    checksDays: toInt(process.env.CHECKS_RETENTION_DAYS, 90),
    incidentsDays: toInt(process.env.INCIDENTS_RETENTION_DAYS, 365),
    // README documents HEARTBEAT_PINGS_RETENTION_DAYS; accept the shorter
    // legacy name too so existing deployments keep working.
    heartbeatPingsDays: toInt(
      process.env.HEARTBEAT_PINGS_RETENTION_DAYS ?? process.env.HEARTBEAT_RETENTION_DAYS,
      30
    ),
    auditDays: toInt(process.env.AUDIT_RETENTION_DAYS, 180),
    runIntervalHours: toInt(process.env.RETENTION_RUN_INTERVAL_HOURS, 6),
    vacuum: toBool(process.env.RETENTION_VACUUM, true),
  },
  paths: {
    root: path.resolve(__dirname, '..'),
    logs: path.resolve(__dirname, '..', 'logs'),
    schemaMysql: path.resolve(__dirname, '..', 'sql', 'schema.mysql.sql'),
    schemaSqlite: path.resolve(__dirname, '..', 'sql', 'schema.sqlite.sql'),
    bundledLogo: path.resolve(__dirname, '..', 'public', 'img', 'logo-mark.svg'),
    bundledFavicon: path.resolve(__dirname, '..', 'public', 'img', 'favicon.svg'),
  },
  branding: {
    appName: (process.env.APP_NAME || 'Uptime').trim() || 'Uptime',
    tagline: process.env.APP_TAGLINE != null
      ? String(process.env.APP_TAGLINE)
      : 'self-hosted monitor',
    logoPath: resolveOptionalPath(process.env.APP_LOGO_PATH),
    faviconPath: resolveOptionalPath(process.env.APP_FAVICON_PATH),
    credits: {
      hide: toBool(process.env.FOOTER_CREDITS_HIDE, false),
      lead: process.env.FOOTER_CREDITS_LEAD != null
        ? String(process.env.FOOTER_CREDITS_LEAD)
        : 'Crafted by',
      text: (process.env.FOOTER_CREDITS_TEXT || 'codewizdevs').trim() || 'codewizdevs',
      url: (process.env.FOOTER_CREDITS_URL || 'https://github.com/codewizdevs').trim() || '#',
    },
  },
};

module.exports = config;
