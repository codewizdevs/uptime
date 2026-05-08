'use strict';

const session = require('express-session');
const config = require('./config');
const logger = require('./logger');

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

// Accept only same-origin paths starting with a single slash followed by a
// non-slash, non-backslash character. Rejects "//evil.com", "/\\evil.com",
// absolute URLs, and any value that browsers might interpret as cross-origin.
function safeReturnTo(raw) {
  if (typeof raw !== 'string' || !raw) return '/';
  if (!/^\/[^/\\]/.test(raw)) return '/';
  return raw;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method === 'GET') {
    const safe = safeReturnTo(req.originalUrl);
    if (safe !== '/') req.session.returnTo = safe;
  }
  return res.redirect('/login');
}

function attemptLogin(req, username, password) {
  const ok = username === config.admin.user && password === config.admin.pass;
  if (!ok) {
    logger.warn({ username, ip: req.ip }, 'auth.login_failed');
    return false;
  }
  req.session.user = { username };
  logger.info({ username, ip: req.ip }, 'auth.login_success');
  return true;
}

function logout(req) {
  const username = req.session?.user?.username;
  return new Promise((resolve) => {
    req.session.destroy(() => {
      logger.info({ username }, 'auth.logout');
      resolve();
    });
  });
}

module.exports = { sessionMiddleware, requireAuth, attemptLogin, logout, safeReturnTo };
