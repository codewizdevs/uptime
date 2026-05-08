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
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-please-change',
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
