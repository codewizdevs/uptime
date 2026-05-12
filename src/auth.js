'use strict';

const crypto = require('crypto');
const session = require('express-session');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const rateLimit = require('./lib/rateLimit');
const audit = require('./lib/audit');
const users = require('./lib/users');

// ─── Minimal RFC 6238 TOTP implementation (no external dep) ─────────────
const TOTP_STEP_S = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  const buf = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      buf.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(buf);
}

function hotp(secretBytes, counter) {
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hmac = require('crypto').createHmac('sha1', secretBytes).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function totpAt(secretB32, when = Date.now()) {
  return hotp(base32Decode(secretB32), Math.floor(when / 1000 / TOTP_STEP_S));
}

function totpVerify(token, secretB32, when = Date.now()) {
  if (!secretB32 || !token) return false;
  const clean = String(token).replace(/\s+/g, '');
  if (!/^[0-9]{6}$/.test(clean)) return false;
  const counter = Math.floor(when / 1000 / TOTP_STEP_S);
  const secret = base32Decode(secretB32);
  for (let w = -TOTP_WINDOW; w <= TOTP_WINDOW; w++) {
    if (hotp(secret, counter + w) === clean) return true;
  }
  return false;
}

const authenticator = {
  generateSecret() {
    return base32Encode(require('crypto').randomBytes(20));
  },
  keyuri(account, issuer, secret) {
    const i = encodeURIComponent(issuer);
    const a = encodeURIComponent(account);
    return `otpauth://totp/${i}:${a}?secret=${secret}&issuer=${i}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`;
  },
  check(token, secret) {
    try { return totpVerify(token, secret); }
    catch { return false; }
  },
};

function sessionMiddleware() {
  return session({
    secret: config.sessionSecret,
    name: 'uptime.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  });
}

function safeReturnTo(raw) {
  if (typeof raw !== 'string' || !raw) return '/';
  if (!/^\/[^/\\]/.test(raw)) return '/';
  // /api/* paths return JSON, not HTML, and are unsuitable as a post-login
  // destination. The dashboard polls /api/sites every 5s, so stale ones used
  // to end up here when a session expired between ticks.
  if (/^\/api(\/|$|\?)/.test(raw)) return '/';
  return raw;
}

// An AJAX request shouldn't be redirected to /login — that just leaks an
// HTML page into a fetch() response and (worse) clobbers returnTo. Detect
// it via every signal browsers actually send: explicit Accept, the legacy
// XHR header, and modern Fetch metadata.
function isAjaxRequest(req) {
  if (req.xhr) return true;
  const xrw = req.get('X-Requested-With');
  if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return true;
  const accept = String(req.get('Accept') || '');
  if (/application\/json/i.test(accept) && !/text\/html/i.test(accept)) return true;
  const dest = String(req.get('Sec-Fetch-Dest') || '').toLowerCase();
  const mode = String(req.get('Sec-Fetch-Mode') || '').toLowerCase();
  if (dest === 'empty' && (mode === 'cors' || mode === 'no-cors' || mode === 'same-origin')) {
    return true;
  }
  return false;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  // JSON / fetch / XHR → 401, never a 302 to /login.
  if (isAjaxRequest(req) || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method === 'GET') {
    const safe = safeReturnTo(req.originalUrl);
    if (safe !== '/') req.session.returnTo = safe;
  }
  return res.redirect('/login');
}

// ─── TOTP state on the singleton `settings` row (env admin only) ────────
// DB users keep their own totp_secret / totp_enabled / totp_recovery_codes on
// the `users` row — see src/lib/users.js. The functions below operate on the
// env admin's singleton state only.
async function getTotpState() {
  const rows = await db.query(`SELECT totp_secret, totp_enabled, totp_recovery_codes FROM settings WHERE id = 1`);
  const r = rows[0] || {};
  let codes = [];
  if (r.totp_recovery_codes) {
    try { codes = JSON.parse(r.totp_recovery_codes); } catch { codes = []; }
  }
  return {
    secret: r.totp_secret || null,
    enabled: !!r.totp_enabled,
    recoveryCodes: codes,
  };
}

async function saveTotpState({ secret, enabled, recoveryCodes }) {
  await db.query(
    `UPDATE settings SET
       totp_secret = ?,
       totp_enabled = ?,
       totp_recovery_codes = ?
     WHERE id = 1`,
    [
      secret || null,
      enabled ? 1 : 0,
      recoveryCodes ? JSON.stringify(recoveryCodes) : null,
    ]
  );
}

// Per-user TOTP state. Reads from / writes to `users` row directly.
async function getUserTotpState(userId) {
  const u = await users.getById(userId);
  if (!u) return { secret: null, enabled: false, recoveryCodes: [] };
  let codes = [];
  if (u.totp_recovery_codes) {
    try { codes = JSON.parse(u.totp_recovery_codes); } catch { codes = []; }
  }
  return { secret: u.totp_secret, enabled: !!u.totp_enabled, recoveryCodes: codes };
}

async function saveUserTotpState(userId, { secret, enabled, recoveryCodes }) {
  await users.setTotp(userId, { secret, enabled, recoveryCodes });
}

function generateRecoveryCodes(n = 10) {
  // Codes the user actually types — keep them short and unambiguous.
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g).join('-'));
  }
  return out;
}

function hashRecovery(code) {
  return crypto.createHash('sha256').update(String(code).toUpperCase().replace(/\s+/g, ''), 'utf8').digest('hex');
}

async function verifyTotpFromState(state, code) {
  if (!state || !state.enabled || !state.secret) return false;
  const clean = String(code || '').replace(/\s+/g, '');
  return authenticator.check(clean, state.secret);
}

async function consumeRecoveryFromState(state, code, save) {
  if (!state || !state.enabled || !state.recoveryCodes?.length) return false;
  const target = hashRecovery(code);
  const idx = state.recoveryCodes.indexOf(target);
  if (idx < 0) return false;
  const remaining = state.recoveryCodes.slice();
  remaining.splice(idx, 1);
  await save({ ...state, recoveryCodes: remaining });
  return true;
}

// Legacy single-user helpers — kept for the env-admin 2FA management page.
async function verifyTotp(code) {
  const state = await getTotpState();
  return verifyTotpFromState(state, code);
}

async function consumeRecovery(code) {
  const state = await getTotpState();
  return consumeRecoveryFromState(state, code, saveTotpState);
}

// Resolve the 2FA backend (env settings vs users row) for a session shape.
async function loadPendingTotpState(pending) {
  if (!pending) return { state: null, save: null };
  if (pending.isEnv) {
    return { state: await getTotpState(), save: saveTotpState };
  }
  if (pending.userId != null) {
    return {
      state: await getUserTotpState(pending.userId),
      save: (s) => saveUserTotpState(pending.userId, s),
    };
  }
  return { state: null, save: null };
}

// ─── Login orchestration ─────────────────────────────────────────────────
function envAdminCredentialsOk(username, password) {
  if (!config.admin.user || !config.admin.pass) return false;
  // Constant-time compare to dodge side channels.
  const a = Buffer.from(String(username));
  const b = Buffer.from(String(config.admin.user));
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  const pa = Buffer.from(String(password));
  const pb = Buffer.from(String(config.admin.pass));
  if (pa.length !== pb.length) return false;
  return crypto.timingSafeEqual(pa, pb);
}

async function startLogin(req, username, password) {
  const cleanUser = String(username || '').trim();
  const lock = rateLimit.checkLocked(req.ip, cleanUser);
  if (lock) return { ok: false, reason: 'locked', message: lock };

  // 1) Try DB users first (the env admin reserved name cannot exist as a DB
  // user, so there's no ambiguity).
  const dbUser = await users.findByUsername(cleanUser);
  if (dbUser) {
    if (dbUser.disabled) {
      rateLimit.recordFailure(req.ip, cleanUser);
      logger.warn({ username: cleanUser, ip: req.ip }, 'auth.login_disabled');
      audit.fromReq(req, 'login.failed', { actor: cleanUser, meta: { reason: 'disabled' } });
      return { ok: false, reason: 'disabled', message: 'Account is disabled' };
    }
    const ok = await users.verifyPassword(dbUser.password_hash, password);
    if (!ok) {
      rateLimit.recordFailure(req.ip, cleanUser);
      logger.warn({ username: cleanUser, ip: req.ip }, 'auth.login_failed');
      audit.fromReq(req, 'login.failed', { actor: cleanUser, meta: { reason: 'bad_credentials' } });
      return { ok: false, reason: 'bad_credentials', message: 'Invalid username or password' };
    }
    if (dbUser.totp_enabled) {
      req.session.pendingUser = {
        userId: dbUser.id,
        username: dbUser.username,
        role: dbUser.role,
        isEnv: false,
        ts: Date.now(),
      };
      return { ok: true, needs2fa: true };
    }
    await finalizeDbLogin(req, dbUser);
    return { ok: true, needs2fa: false };
  }

  // 2) Fall back to env super-admin.
  if (envAdminCredentialsOk(cleanUser, password)) {
    const totp = await getTotpState();
    if (totp.enabled) {
      req.session.pendingUser = {
        userId: null,
        username: cleanUser,
        role: 'admin',
        isEnv: true,
        ts: Date.now(),
      };
      return { ok: true, needs2fa: true };
    }
    finalizeEnvLogin(req, cleanUser);
    return { ok: true, needs2fa: false };
  }

  rateLimit.recordFailure(req.ip, cleanUser);
  logger.warn({ username: cleanUser, ip: req.ip }, 'auth.login_failed');
  audit.fromReq(req, 'login.failed', { actor: cleanUser, meta: { reason: 'bad_credentials' } });
  return { ok: false, reason: 'bad_credentials', message: 'Invalid username or password' };
}

function finalizeEnvLogin(req, username) {
  rateLimit.recordSuccess(req.ip, username);
  req.session.user = {
    id: null,
    isEnv: true,
    username,
    role: 'admin',
    mustChangePassword: false,
  };
  delete req.session.pendingUser;
  logger.info({ username, ip: req.ip, isEnv: true }, 'auth.login_success');
  audit.fromReq(req, 'login.success', { actor: username, meta: { isEnv: true } });
}

async function finalizeDbLogin(req, dbUser) {
  rateLimit.recordSuccess(req.ip, dbUser.username);
  req.session.user = {
    id: dbUser.id,
    isEnv: false,
    username: dbUser.username,
    role: dbUser.role,
    mustChangePassword: !!dbUser.must_change_password,
  };
  delete req.session.pendingUser;
  try { await users.recordLogin(dbUser.id, req.ip); }
  catch (err) { logger.warn({ err: err.message, id: dbUser.id }, 'auth.record_login_failed'); }
  logger.info({ username: dbUser.username, ip: req.ip, role: dbUser.role }, 'auth.login_success');
  audit.fromReq(req, 'login.success', { actor: dbUser.username });
}

async function complete2fa(req, code) {
  const pending = req.session.pendingUser;
  if (!pending || !pending.username) {
    return { ok: false, message: 'No pending login' };
  }
  if (Date.now() - (pending.ts || 0) > 5 * 60 * 1000) {
    delete req.session.pendingUser;
    return { ok: false, message: 'Login expired, please sign in again' };
  }

  const clean = String(code || '').replace(/\s+/g, '');
  if (!clean) return { ok: false, message: '2FA code required' };

  const { state, save } = await loadPendingTotpState(pending);
  if (!state) return { ok: false, message: 'No 2FA configured for this account' };

  const totpOk = await verifyTotpFromState(state, clean);
  if (totpOk) {
    if (pending.isEnv) finalizeEnvLogin(req, pending.username);
    else {
      const dbUser = await users.getById(pending.userId);
      if (!dbUser || dbUser.disabled) {
        delete req.session.pendingUser;
        return { ok: false, message: 'Account is no longer available' };
      }
      await finalizeDbLogin(req, dbUser);
    }
    return { ok: true };
  }

  const recOk = await consumeRecoveryFromState(state, clean, save);
  if (recOk) {
    if (pending.isEnv) finalizeEnvLogin(req, pending.username);
    else {
      const dbUser = await users.getById(pending.userId);
      if (!dbUser || dbUser.disabled) {
        delete req.session.pendingUser;
        return { ok: false, message: 'Account is no longer available' };
      }
      await finalizeDbLogin(req, dbUser);
    }
    audit.fromReq(req, '2fa.recovery_used', { actor: pending.username });
    return { ok: true, recovery: true };
  }

  rateLimit.recordFailure(req.ip, pending.username);
  logger.warn({ ip: req.ip, username: pending.username }, 'auth.2fa_failed');
  audit.fromReq(req, '2fa.failed', { actor: pending.username });
  return { ok: false, message: 'Invalid 2FA code' };
}

// Tell the login route whether the pending user actually needs a TOTP step.
async function pendingNeeds2fa(req) {
  const pending = req.session?.pendingUser;
  if (!pending) return false;
  const { state } = await loadPendingTotpState(pending);
  return !!state && !!state.enabled;
}

// Block actions for sessions whose user got disabled mid-flight.
async function loadFreshSessionUser(req) {
  const u = req.session?.user;
  if (!u) return null;
  if (u.isEnv) return u;
  const fresh = await users.getById(u.id);
  if (!fresh || fresh.disabled) return null;
  return {
    id: fresh.id,
    isEnv: false,
    username: fresh.username,
    role: fresh.role,
    mustChangePassword: !!fresh.must_change_password,
  };
}

function logout(req) {
  const u = req.session?.user;
  const username = u?.username;
  const actorUserId = u && !u.isEnv ? u.id : null;
  const ip = req.ip;
  return new Promise((resolve) => {
    req.session.destroy(() => {
      logger.info({ username }, 'auth.logout');
      if (username) audit.record({ actor: username, actorUserId, ip, action: 'logout' });
      resolve();
    });
  });
}

module.exports = {
  sessionMiddleware,
  requireAuth,
  safeReturnTo,
  startLogin,
  complete2fa,
  logout,
  pendingNeeds2fa,
  loadFreshSessionUser,
  // 2FA management — env admin (singleton settings row)
  authenticator,
  getTotpState,
  saveTotpState,
  // 2FA management — per-user (users row)
  getUserTotpState,
  saveUserTotpState,
  generateRecoveryCodes,
  hashRecovery,
};
