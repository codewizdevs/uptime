'use strict';

// Public status page (no auth). Mounted before requireAuth.
// Honors the per-deployment toggle:
//   settings.status_page_enabled = 1  -> page is served
//   settings.status_page_public  = 1  -> open to the internet
//   settings.status_page_public  = 0  -> requires ?token=<settings.status_page_token>
//
// Companion endpoints:
//   GET /status         -> HTML
//   GET /status.json    -> same data as JSON
//   GET /status.rss     -> Atom feed of recent incidents

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const stats = require('../lib/stats');
const { formatDuration } = require('../lib/format');
const config = require('../config');

const router = express.Router();

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function loadStatusPageSettings() {
  const rows = await db.query(
    `SELECT status_page_enabled, status_page_public, status_page_token,
            status_page_title, status_page_description
       FROM settings WHERE id = 1`
  );
  const r = rows[0] || {};
  return {
    enabled: r.status_page_enabled == null ? true : !!r.status_page_enabled,
    public: r.status_page_public == null ? true : !!r.status_page_public,
    token: r.status_page_token || null,
    title: (r.status_page_title || '').trim() || null,
    description: (r.status_page_description || '').trim() || null,
  };
}

async function ensureStatusPageAccess(req, res) {
  const settings = await loadStatusPageSettings();
  if (!settings.enabled) {
    res.status(404).type('text').send('Status page is disabled');
    return null;
  }
  if (!settings.public) {
    const provided = String(req.query.token || '').trim();
    if (!settings.token || !provided || provided !== settings.token) {
      res.status(403).type('text').send('Forbidden');
      return null;
    }
  }
  return settings;
}

// Build the full data structure used by /status, /status.json, and /status.rss.
async function buildStatusData() {
  const sites = await db.query(
    `SELECT id, name, display_name, url, monitor_type, current_state, paused,
            status_page_group, status_page_order, status_page_excluded
       FROM sites
      WHERE status_page_excluded = 0
      ORDER BY status_page_order ASC, name ASC`
  );

  const monitors = [];
  for (const s of sites) {
    if (s.paused) continue; // skip paused; they don't reflect real status
    const [daily, uptime24h, last] = await Promise.all([
      stats.dailyUptime(s.id, 90),
      stats.uptimePct(s.id, 24),
      stats.lastCheck(s.id),
    ]);
    monitors.push({
      id: s.id,
      name: s.name,
      display_name: s.display_name,
      url: s.url,
      monitor_type: s.monitor_type,
      current_state: s.current_state,
      status_page_group: s.status_page_group || '',
      daily,
      uptime_24h: typeof uptime24h === 'number' ? uptime24h : null,
      last_check: last,
    });
  }

  // Group by status_page_group (text). Empty group becomes the "default"
  // unnamed group rendered first, without a heading. Other groups are
  // alphabetical for stable rendering.
  const byGroup = new Map();
  for (const m of monitors) {
    const k = m.status_page_group || '';
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(m);
  }
  const groupNames = Array.from(byGroup.keys()).sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    return a.localeCompare(b);
  });
  const groups = groupNames.map((name) => ({ name, monitors: byGroup.get(name) }));

  // Recent incidents — keep raw rows + human-readable duration.
  const raw = await stats.recentIncidentsGlobal(25);
  const incidents = raw.map((inc) => ({
    ...inc,
    duration_human: inc.ended_at && inc.duration_seconds != null
      ? formatDuration(inc.duration_seconds)
      : '',
  }));

  return { groups, incidents, renderedAt: new Date().toISOString() };
}

router.get('/status', async (req, res, next) => {
  try {
    const settings = await ensureStatusPageAccess(req, res);
    if (!settings) return;
    const data = await buildStatusData();
    const tokenQuery = settings.public
      ? ''
      : '?token=' + encodeURIComponent(req.query.token || '');
    res.render('status', {
      layout: 'status-layout',
      title: settings.title || ((res.locals.branding?.appName || config.branding.appName) + ' status'),
      description: settings.description || '',
      statusPageTitle: settings.title,
      statusPageDescription: settings.description,
      tokenQuery,
      rssUrl: '/status.rss' + tokenQuery,
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/status.json', async (req, res, next) => {
  try {
    const settings = await ensureStatusPageAccess(req, res);
    if (!settings) return;
    const data = await buildStatusData();
    res.json({
      app: res.locals.branding?.appName || config.branding.appName,
      title: settings.title,
      description: settings.description,
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/status.rss', async (req, res, next) => {
  try {
    const settings = await ensureStatusPageAccess(req, res);
    if (!settings) return;
    const data = await buildStatusData();
    const base = config.publicBaseUrl.replace(/\/$/, '');
    const feedTitle = settings.title || ((res.locals.branding?.appName || config.branding.appName) + ' incidents');
    const feedId = base + '/status.rss';
    const updated = data.renderedAt;
    const entries = data.incidents.map((inc) => {
      const title = (inc.site_display_name || inc.site_name)
        + (inc.ended_at ? ' — resolved' : ' — ongoing');
      const summary = (inc.last_error || '').trim() || 'Incident reported';
      const id = base + '/status#incident-' + inc.id;
      const ts = inc.ended_at || inc.started_at;
      return `<entry>
  <id>${escapeXml(id)}</id>
  <title>${escapeXml(title)}</title>
  <updated>${escapeXml(ts)}</updated>
  <published>${escapeXml(inc.started_at)}</published>
  <link href="${escapeXml(base + '/status')}"/>
  <summary>${escapeXml(summary)}${inc.ended_at && inc.duration_seconds != null ? ' (downtime: ' + escapeXml(formatDuration(inc.duration_seconds)) + ')' : ''}</summary>
</entry>`;
    }).join('\n');
    res.type('application/atom+xml; charset=utf-8').send(
      `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escapeXml(feedId)}</id>
  <title>${escapeXml(feedTitle)}</title>
  <updated>${escapeXml(updated)}</updated>
  <link rel="self" href="${escapeXml(feedId)}"/>
  <link href="${escapeXml(base + '/status')}"/>
${entries}
</feed>`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.loadStatusPageSettings = loadStatusPageSettings;
