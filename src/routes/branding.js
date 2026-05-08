'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const logger = require('../logger');

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

function resolveAsset(customPath, fallbackPath) {
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

function send(res, file, mime) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', config.appDebug ? 'no-store' : 'public, max-age=86400');
  res.sendFile(file);
}

router.get('/branding/logo', (req, res) => {
  const { file, mime } = resolveAsset(config.branding.logoPath, config.paths.bundledLogo);
  send(res, file, mime);
});

router.get('/branding/favicon', (req, res) => {
  const { file, mime } = resolveAsset(config.branding.faviconPath, config.paths.bundledFavicon);
  send(res, file, mime);
});

module.exports = router;
