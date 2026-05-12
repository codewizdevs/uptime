'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const cookieParser = require('cookie-parser');
const flash = require('connect-flash');
const pinoHttp = require('pino-http');

const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const monitor = require('./monitor');
const { sessionMiddleware, requireAuth, loadFreshSessionUser } = require('./auth');

async function main() {
  await db.ensureSchema();
  await require('./lib/migrations').run();
  require('./lib/retention').schedule();

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.set('views', path.resolve(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.set('layout', 'layout');
  app.use(expressLayouts);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.headers['x-request-id'] || crypto.randomUUID(),
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return config.appDebug ? 'debug' : 'info';
      },
      customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
      autoLogging: { ignore: (req) => req.url.startsWith('/static/') || req.url === '/favicon.ico' },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.headers['x-forwarded-for'] || req.connection?.remoteAddress }),
      },
    })
  );

  app.use(express.urlencoded({ extended: true, limit: '256kb' }));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  app.use('/static', express.static(path.resolve(__dirname, '..', 'public'), {
    maxAge: config.appDebug ? 0 : '7d',
    etag: true,
    lastModified: true,
  }));
  app.get('/favicon.ico', (req, res) => res.redirect(302, '/branding/favicon'));

  // Unauthenticated liveness probe for container healthchecks / load balancers.
  // Intentionally cheap — no DB query, no template rendering.
  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ts: Date.now() });
  });

  const assetVersion = config.appDebug ? Date.now().toString(36) : crypto.randomUUID().slice(0, 8);

  const brandingLib = require('./lib/branding');

  // Public-safe locals available to every route (including unauthenticated
  // ones like /status, /branding, /ping). Must run before any router that
  // renders templates.
  app.use(async (req, res, next) => {
    res.locals.theme = req.cookies?.theme === 'light' ? 'light' : 'dark';
    res.locals.publicBaseUrl = config.publicBaseUrl;
    res.locals.appDebug = config.appDebug;
    res.locals.currentPath = req.path;
    res.locals.assetV = config.appDebug ? Date.now().toString(36) : assetVersion;
    try {
      res.locals.branding = await brandingLib.get();
    } catch (err) {
      // Never fail a request because branding load blipped — fall back to env.
      res.locals.branding = { ...config.branding, logoVersion: 0, faviconVersion: 0, hasCustomLogo: false, hasCustomFavicon: false };
    }
    next();
  });

  app.use(require('./routes/branding'));
  app.use(require('./routes/ping'));
  app.use(require('./routes/status'));
  app.use(require('./routes/api'));

  app.use(sessionMiddleware());
  app.use(flash());

  // Re-load the session user from the `users` table on every request. This
  // is what makes "disable account" or "role change" take effect immediately
  // without waiting for cookie expiry. Skips when there's no session at all.
  app.use(async (req, res, next) => {
    if (!req.session?.user) return next();
    if (req.session.user.isEnv) return next();
    try {
      const fresh = await loadFreshSessionUser(req);
      if (!fresh) {
        req.session.destroy(() => {});
        return next();
      }
      req.session.user = fresh;
    } catch (err) {
      logger.warn({ err: err.message }, 'session.refresh_failed');
    }
    next();
  });

  // Auth-aware locals — only meaningful once session + flash are loaded.
  app.use((req, res, next) => {
    res.locals.user = req.session?.user || null;
    res.locals.flash = {
      success: req.flash('success'),
      error: req.flash('error'),
      warning: req.flash('warning'),
    };
    next();
  });

  app.use('/', require('./routes/auth'));

  app.use(requireAuth);

  // Force users with must_change_password=1 onto /settings/account before
  // they can navigate anywhere else. Logout and the account page are exempt.
  app.use((req, res, next) => {
    const u = req.session?.user;
    if (!u || u.isEnv || !u.mustChangePassword) return next();
    const allowed = req.path === '/settings/account'
      || req.path === '/settings/account/password'
      || req.path === '/logout';
    if (allowed) return next();
    if (req.method !== 'GET') return res.redirect('/settings/account');
    req.flash('warning', 'Please choose a new password before continuing.');
    res.redirect('/settings/account');
  });

  app.use('/', require('./routes/channels'));
  app.use('/', require('./routes/settings'));
  app.use('/', require('./routes/tags'));
  app.use('/', require('./routes/backup'));
  app.use('/', require('./routes/sites'));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', error: 'Page not found' });
  });

  app.use((err, req, res, _next) => {
    logger.error({ err, reqId: req.id }, 'request.error');
    res.status(500).render('error', { title: 'Error', error: config.appDebug ? err.stack : err.message });
  });

  await monitor.start();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, baseUrl: config.publicBaseUrl }, 'http.listening');
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutdown.starting');
    server.close(async () => {
      try {
        await db.close();
      } catch (err) {
        logger.error({ err }, 'shutdown.db_close_failed');
      }
      logger.info('shutdown.complete');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => logger.fatal({ err }, 'uncaughtException'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
