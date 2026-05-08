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
const { sessionMiddleware, requireAuth } = require('./auth');

async function main() {
  await db.ensureSchema();

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

  app.use(require('./routes/branding'));
  app.use(require('./routes/ping'));

  app.use(sessionMiddleware());
  app.use(flash());

  const assetVersion = config.appDebug ? Date.now().toString(36) : crypto.randomUUID().slice(0, 8);
  app.use((req, res, next) => {
    res.locals.user = req.session?.user || null;
    res.locals.theme = req.cookies?.theme === 'light' ? 'light' : 'dark';
    res.locals.flash = {
      success: req.flash('success'),
      error: req.flash('error'),
      warning: req.flash('warning'),
    };
    res.locals.publicBaseUrl = config.publicBaseUrl;
    res.locals.appDebug = config.appDebug;
    res.locals.currentPath = req.path;
    res.locals.assetV = config.appDebug ? Date.now().toString(36) : assetVersion;
    res.locals.branding = config.branding;
    next();
  });

  app.use('/', require('./routes/auth'));

  app.use(requireAuth);

  app.use('/', require('./routes/channels'));
  app.use('/', require('./routes/settings'));
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
