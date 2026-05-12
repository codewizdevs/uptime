'use strict';

// Database-backed whitelabel/branding settings.
//
// Resolution order for any field:
//   1. DB value on `settings` row (if non-null / non-empty)
//   2. .env value (legacy, still respected so existing deploys keep working)
//   3. built-in default ("Uptime", "Crafted by codewizdevs", etc.)
//
// Binary assets (logo, favicon) live in their own `branding_assets` table
// keyed by `kind`. `/branding/logo` and `/branding/favicon` will serve the
// DB row when present, then env path, then the bundled SVG.

const fs = require('fs');
const path = require('path');
const db = require('../db');
const logger = require('../logger');
const config = require('../config');

const CACHE_TTL_MS = 5000;
let cache = null;
let cacheAt = 0;

const ASSET_CACHE_TTL_MS = 2000;
const assetCache = new Map();
const assetCacheAt = new Map();

const ALLOWED_MIME = {
  logo: new Set(['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  favicon: new Set(['image/svg+xml', 'image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/webp', 'image/gif']),
};

const MAX_BYTES = 512 * 1024;

function emptyToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function defaults() {
  return {
    appName: 'Uptime',
    tagline: 'self-hosted monitor',
    credits: {
      hide: false,
      lead: 'Crafted by',
      text: 'codewizdevs',
      url: 'https://github.com/codewizdevs',
    },
  };
}

function fromEnv() {
  // Pulled from `config.branding` which read env at boot. Treat unset env
  // (i.e. matches the default) as "no override" so DB always wins.
  const d = defaults();
  const env = config.branding || {};
  return {
    appName: env.appName && env.appName !== d.appName ? env.appName : null,
    tagline: env.tagline && env.tagline !== d.tagline ? env.tagline : null,
    credits: {
      hide:
        env.credits && typeof env.credits.hide === 'boolean' && env.credits.hide !== d.credits.hide
          ? env.credits.hide
          : null,
      lead:
        env.credits && env.credits.lead && env.credits.lead !== d.credits.lead
          ? env.credits.lead
          : null,
      text:
        env.credits && env.credits.text && env.credits.text !== d.credits.text
          ? env.credits.text
          : null,
      url:
        env.credits && env.credits.url && env.credits.url !== d.credits.url
          ? env.credits.url
          : null,
    },
  };
}

function merge(base, override) {
  const out = {
    appName: override.appName || base.appName,
    tagline: override.tagline != null ? override.tagline : base.tagline,
    credits: {
      hide: override.credits.hide != null ? override.credits.hide : base.credits.hide,
      lead: override.credits.lead != null ? override.credits.lead : base.credits.lead,
      text: override.credits.text || base.credits.text,
      url: override.credits.url || base.credits.url,
    },
  };
  return out;
}

async function loadFromDb() {
  const rows = await db.query(
    `SELECT brand_app_name, brand_tagline, brand_credits_hide,
            brand_credits_lead, brand_credits_text, brand_credits_url
       FROM settings WHERE id = 1`
  );
  const r = rows[0] || {};
  return {
    appName: emptyToNull(r.brand_app_name),
    tagline: r.brand_tagline == null ? null : String(r.brand_tagline),
    credits: {
      hide:
        r.brand_credits_hide == null
          ? null
          : Boolean(Number(r.brand_credits_hide)),
      lead: r.brand_credits_lead == null ? null : String(r.brand_credits_lead),
      text: emptyToNull(r.brand_credits_text),
      url: emptyToNull(r.brand_credits_url),
    },
  };
}

async function get() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;
  let dbVals;
  try {
    dbVals = await loadFromDb();
  } catch (err) {
    logger.warn({ err: err.message }, 'branding.load_failed_using_env');
    dbVals = { appName: null, tagline: null, credits: { hide: null, lead: null, text: null, url: null } };
  }
  // DB > env > default
  const resolved = merge(merge(defaults(), fromEnv()), dbVals);
  // Logo/favicon URLs include `updated_at` of the binary asset so browser
  // caches break on upload without touching assetV.
  const [logoMeta, favMeta] = await Promise.all([
    getAssetMeta('logo').catch(() => null),
    getAssetMeta('favicon').catch(() => null),
  ]);
  resolved.logoVersion = logoMeta ? Date.parse(logoMeta.updated_at) || 0 : 0;
  resolved.faviconVersion = favMeta ? Date.parse(favMeta.updated_at) || 0 : 0;
  resolved.hasCustomLogo = !!logoMeta;
  resolved.hasCustomFavicon = !!favMeta;
  cache = resolved;
  cacheAt = now;
  return resolved;
}

function invalidate() {
  cache = null;
  cacheAt = 0;
  assetCache.clear();
  assetCacheAt.clear();
}

async function update(values) {
  const sql = `
    UPDATE settings SET
      brand_app_name      = ?,
      brand_tagline       = ?,
      brand_credits_hide  = ?,
      brand_credits_lead  = ?,
      brand_credits_text  = ?,
      brand_credits_url   = ?
    WHERE id = 1
  `;
  await db.query(sql, [
    emptyToNull(values.appName),
    values.tagline == null ? null : String(values.tagline), // empty string allowed (= hide tagline)
    values.credits == null || values.credits.hide == null ? null : (values.credits.hide ? 1 : 0),
    values.credits && values.credits.lead != null ? String(values.credits.lead) : null,
    emptyToNull(values.credits && values.credits.text),
    emptyToNull(values.credits && values.credits.url),
  ]);
  invalidate();
}

async function getAssetMeta(kind) {
  if (!['logo', 'favicon'].includes(kind)) return null;
  const rows = await db.query(
    `SELECT kind, mime, filename, updated_at FROM branding_assets WHERE kind = ?`,
    [kind]
  );
  return rows[0] || null;
}

async function getAsset(kind) {
  if (!['logo', 'favicon'].includes(kind)) return null;
  const now = Date.now();
  if (assetCache.has(kind) && now - (assetCacheAt.get(kind) || 0) < ASSET_CACHE_TTL_MS) {
    return assetCache.get(kind);
  }
  const rows = await db.query(
    `SELECT kind, mime, filename, bytes, updated_at FROM branding_assets WHERE kind = ?`,
    [kind]
  );
  const row = rows[0];
  if (!row) {
    assetCache.delete(kind);
    return null;
  }
  // mysql2 returns Buffer; better-sqlite3 returns Buffer for BLOB too.
  const out = {
    kind: row.kind,
    mime: row.mime,
    filename: row.filename,
    bytes: Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes),
    updated_at: row.updated_at,
  };
  assetCache.set(kind, out);
  assetCacheAt.set(kind, now);
  return out;
}

async function setAsset(kind, { mime, bytes, filename }) {
  if (!['logo', 'favicon'].includes(kind)) {
    throw new Error('unsupported asset kind: ' + kind);
  }
  if (!ALLOWED_MIME[kind].has(mime)) {
    throw new Error('unsupported mime type for ' + kind + ': ' + mime);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error('empty asset bytes');
  }
  if (bytes.length > MAX_BYTES) {
    throw new Error('asset too large (max ' + MAX_BYTES + ' bytes)');
  }
  const exists = await getAssetMeta(kind);
  if (exists) {
    if (db.dialect === 'sqlite') {
      await db.query(
        `UPDATE branding_assets
            SET mime = ?, filename = ?, bytes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE kind = ?`,
        [mime, filename || null, bytes, kind]
      );
    } else {
      await db.query(
        `UPDATE branding_assets SET mime = ?, filename = ?, bytes = ? WHERE kind = ?`,
        [mime, filename || null, bytes, kind]
      );
    }
  } else {
    await db.query(
      `INSERT INTO branding_assets (kind, mime, filename, bytes) VALUES (?, ?, ?, ?)`,
      [kind, mime, filename || null, bytes]
    );
  }
  invalidate();
}

async function deleteAsset(kind) {
  if (!['logo', 'favicon'].includes(kind)) return;
  await db.query(`DELETE FROM branding_assets WHERE kind = ?`, [kind]);
  invalidate();
}

function envAssetPath(kind) {
  if (kind === 'logo') return config.branding && config.branding.logoPath;
  if (kind === 'favicon') return config.branding && config.branding.faviconPath;
  return null;
}

function bundledAssetPath(kind) {
  if (kind === 'logo') return config.paths.bundledLogo;
  if (kind === 'favicon') return config.paths.bundledFavicon;
  return null;
}

const ENV_FILE_MIME_BY_EXT = {
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
};

function resolveFallbackFile(kind) {
  const envPath = envAssetPath(kind);
  if (envPath && fs.existsSync(envPath)) {
    const ext = path.extname(envPath).toLowerCase();
    return { file: envPath, mime: ENV_FILE_MIME_BY_EXT[ext] || 'application/octet-stream' };
  }
  const bundled = bundledAssetPath(kind);
  const ext = path.extname(bundled).toLowerCase();
  return { file: bundled, mime: ENV_FILE_MIME_BY_EXT[ext] || 'image/svg+xml' };
}

module.exports = {
  get,
  update,
  getAsset,
  getAssetMeta,
  setAsset,
  deleteAsset,
  invalidate,
  resolveFallbackFile,
  defaults,
  MAX_BYTES,
  ALLOWED_MIME,
};
