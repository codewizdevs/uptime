'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const logger = require('../logger');
const brandingLib = require('../lib/branding');

const router = express.Router();

const ALLOWED_EXT = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico']);

const MIME_BY_EXT = {
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
};

function envFallback(customPath, fallbackPath) {
  if (customPath) {
    const ext = path.extname(customPath).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      logger.warn({ customPath, ext }, 'branding.unsupported_ext_falling_back');
      return { file: fallbackPath, mime: MIME_BY_EXT[path.extname(fallbackPath).toLowerCase()] || 'image/svg+xml' };
    }
    if (!fs.existsSync(customPath)) {
      logger.warn({ customPath }, 'branding.custom_file_missing_falling_back');
      return { file: fallbackPath, mime: MIME_BY_EXT[path.extname(fallbackPath).toLowerCase()] || 'image/svg+xml' };
    }
    return { file: customPath, mime: MIME_BY_EXT[ext] || 'application/octet-stream' };
  }
  return { file: fallbackPath, mime: MIME_BY_EXT[path.extname(fallbackPath).toLowerCase()] || 'image/svg+xml' };
}

function sendFile(res, file, mime) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', config.appDebug ? 'no-store' : 'public, max-age=86400');
  res.sendFile(file);
}

function sendBuffer(res, mime, bytes, updatedAt) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', config.appDebug ? 'no-store' : 'public, max-age=86400');
  if (updatedAt) res.setHeader('Last-Modified', new Date(updatedAt).toUTCString());
  res.end(bytes);
}

async function serveAsset(req, res, kind, envPath, fallbackPath) {
  try {
    const asset = await brandingLib.getAsset(kind);
    if (asset) return sendBuffer(res, asset.mime, asset.bytes, asset.updated_at);
  } catch (err) {
    logger.warn({ err: err.message, kind }, 'branding.db_asset_load_failed');
  }
  const { file, mime } = envFallback(envPath, fallbackPath);
  sendFile(res, file, mime);
}

router.get('/branding/logo', (req, res) => {
  serveAsset(req, res, 'logo', config.branding.logoPath, config.paths.bundledLogo);
});

router.get('/branding/favicon', (req, res) => {
  serveAsset(req, res, 'favicon', config.branding.faviconPath, config.paths.bundledFavicon);
});

module.exports = router;
