'use strict';

const express = require('express');
const db = require('../db');
const backup = require('../lib/backup');
const channels = require('../lib/channels');
const logger = require('../logger');

const router = express.Router();

const importBodyParser = express.urlencoded({ extended: true, limit: '16mb' });

function safeFilename(prefix) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${prefix}-${stamp}.json`;
}

function parseSelectedIds(body) {
  let raw = body.site_ids;
  if (raw == null) return [];
  if (!Array.isArray(raw)) raw = [raw];
  return raw
    .map((v) => parseInt(v, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

router.get('/settings/backup', async (req, res, next) => {
  try {
    const [sites, allChannels] = await Promise.all([
      db.query('SELECT id, name, monitor_type, paused FROM sites ORDER BY name ASC'),
      channels.listChannels(),
    ]);
    res.render('settings-backup', {
      title: 'Backup & restore',
      sites,
      channels: allChannels,
      conflictStrategies: backup.VALID_CONFLICT,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/backup/export', async (req, res, next) => {
  try {
    const b = req.body || {};
    const scope = b.scope === 'selected' ? 'selected' : 'all';
    const includeChannels = b.include_channels === '1' || b.include_channels === 'on';
    const includeSmtp = b.include_smtp === '1' || b.include_smtp === 'on';
    const includeSmtpPassword = includeSmtp && (b.include_smtp_password === '1' || b.include_smtp_password === 'on');

    const siteIds = scope === 'selected' ? parseSelectedIds(b) : null;
    if (scope === 'selected' && !siteIds.length) {
      req.flash('error', 'Select at least one monitor to export, or choose "All monitors".');
      return res.redirect('/settings/backup');
    }

    const payload = await backup.exportConfig({
      siteIds: siteIds || undefined,
      includeChannels,
      includeSmtp,
      includeSmtpPassword,
    });

    const filename = safeFilename('uptime-backup');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    logger.info({
      scope,
      includeChannels,
      includeSmtp,
      includeSmtpPassword,
      counts: payload.counts,
    }, 'backup.exported');
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    next(err);
  }
});

router.post('/settings/backup/import', importBodyParser, async (req, res, next) => {
  try {
    const b = req.body || {};
    const jsonText = typeof b.payload === 'string' ? b.payload : '';
    if (!jsonText.trim()) {
      req.flash('error', 'Paste JSON or choose a backup file before importing.');
      return res.redirect('/settings/backup');
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      req.flash('error', 'Invalid JSON: ' + e.message);
      return res.redirect('/settings/backup');
    }

    const conflict = backup.VALID_CONFLICT.includes(b.conflict) ? b.conflict : 'skip';
    const importMonitors = b.import_monitors !== '0' && b.import_monitors !== 'off';
    const importChannels = b.import_channels !== '0' && b.import_channels !== 'off';
    const importSmtp = b.import_smtp === '1' || b.import_smtp === 'on';

    const summary = await backup.importConfig(parsed, {
      conflict,
      importMonitors,
      importChannels,
      importSmtp,
    });

    const m = summary.monitors;
    const c = summary.channels;
    const parts = [];
    if (importChannels) {
      parts.push(`channels: ${c.created} new, ${c.updated} updated, ${c.skipped} skipped, ${c.renamed} renamed`);
    }
    if (importMonitors) {
      parts.push(`monitors: ${m.created} new, ${m.updated} updated, ${m.skipped} skipped, ${m.renamed} renamed`);
    }
    if (importSmtp) parts.push(summary.smtp.applied ? 'SMTP applied' : 'SMTP not applied');

    const errors = (m.errors || []).concat(c.errors || []);
    const missing = m.missingChannels || [];

    if (errors.length) {
      req.flash('error', `Import had ${errors.length} error(s): ${errors.slice(0, 3).join(' | ')}${errors.length > 3 ? ' (...)' : ''}`);
    }
    if (missing.length) {
      req.flash('warning', `Skipped channel attachments not found locally: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' (...)' : ''}`);
    }
    req.flash('success', `Import complete (${conflict}). ${parts.join(' - ')}`);

    res.redirect('/settings/backup');
  } catch (err) {
    logger.error({ err }, 'backup.import_failed');
    req.flash('error', 'Import failed: ' + err.message);
    res.redirect('/settings/backup');
  }
});

module.exports = router;
