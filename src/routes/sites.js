'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const monitor = require('../monitor');
const stats = require('../lib/stats');
const channels = require('../lib/channels');
const config = require('../config');
const logger = require('../logger');
const { idParam } = require('../lib/ids');

const router = express.Router();
router.param('id', idParam);

const VALID_MONITOR_TYPES = ['active', 'heartbeat'];
const VALID_CHECK_TYPES = ['status', 'string', 'json'];
const VALID_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

function parseHeadersJson(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('headers must be a JSON object');
    }
    return parsed;
  } catch (e) {
    throw new Error('Invalid JSON in headers: ' + e.message);
  }
}

function buildPayload(body) {
  const monitor_type = VALID_MONITOR_TYPES.includes(body.monitor_type) ? body.monitor_type : 'active';
  const failure_threshold = Math.max(1, parseInt(body.failure_threshold, 10) || 1);
  const interval_seconds = Math.max(10, parseInt(body.interval_seconds, 10) || 60);
  const timeout_ms = Math.max(1000, parseInt(body.timeout_ms, 10) || 10000);
  const heartbeat_grace_seconds = Math.max(5, parseInt(body.heartbeat_grace_seconds, 10) || 60);
  const cloudflare_mode = body.cloudflare_mode === '1' || body.cloudflare_mode === 'on' ? 1 : 0;
  const paused = body.paused === '1' || body.paused === 'on' ? 1 : 0;
  const rawMethod = String(body.method || 'GET').toUpperCase();
  const method = VALID_METHODS.includes(rawMethod) ? rawMethod : 'GET';
  const check_type = VALID_CHECK_TYPES.includes(body.check_type) ? body.check_type : 'status';

  const enforced_interval = monitor_type === 'active' && cloudflare_mode ? Math.max(60, interval_seconds) : interval_seconds;

  return {
    name: (body.name || '').trim() || 'Untitled',
    url: monitor_type === 'active' ? (body.url || '').trim() : '',
    monitor_type,
    method,
    interval_seconds: enforced_interval,
    timeout_ms,
    check_type: monitor_type === 'active' ? check_type : null,
    expected_status: monitor_type === 'active' && check_type === 'status' ? (body.expected_status || '200').trim() : null,
    expected_string: monitor_type === 'active' && check_type === 'string' ? (body.expected_string || '') : null,
    json_path: monitor_type === 'active' && check_type === 'json' ? (body.json_path || '').trim() : null,
    expected_json_value: monitor_type === 'active' && check_type === 'json' ? (body.expected_json_value || '') : null,
    request_headers: monitor_type === 'active' ? parseHeadersJson(body.request_headers) : null,
    failure_threshold,
    heartbeat_grace_seconds,
    cloudflare_mode,
    paused,
  };
}

function pickChannelIds(body) {
  let raw = body.channel_ids;
  if (!Array.isArray(raw)) raw = raw == null ? [] : [raw];
  return raw.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0);
}

const PAGE_SIZE = 52;
const VALID_STATES = ['up', 'down', 'unknown', 'paused'];
const VALID_TYPES = ['active', 'heartbeat'];

function parseListFilters(query) {
  const q = String(query.q || '').trim().slice(0, 120);
  const stateRaw = String(query.state || '').trim().toLowerCase();
  const typeRaw = String(query.type || '').trim().toLowerCase();
  const cfRaw = String(query.cf || '').trim().toLowerCase();
  const state = VALID_STATES.includes(stateRaw) ? stateRaw : '';
  const type = VALID_TYPES.includes(typeRaw) ? typeRaw : '';
  const cf = cfRaw === 'on' || cfRaw === 'off' ? cfRaw : '';
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { q, state, type, cf, page };
}

function buildSiteWhere(filters) {
  const where = [];
  const params = [];
  if (filters.q) {
    where.push('(name LIKE ? OR url LIKE ?)');
    const like = `%${filters.q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    params.push(like, like);
  }
  if (filters.state) {
    if (filters.state === 'paused') {
      where.push('paused = 1');
    } else {
      where.push('paused = 0 AND current_state = ?');
      params.push(filters.state);
    }
  }
  if (filters.type) {
    where.push('monitor_type = ?');
    params.push(filters.type);
  }
  if (filters.cf) {
    where.push('cloudflare_mode = ?');
    params.push(filters.cf === 'on' ? 1 : 0);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function qsExceptPage(filters) {
  const parts = [];
  if (filters.q) parts.push('q=' + encodeURIComponent(filters.q));
  if (filters.state) parts.push('state=' + encodeURIComponent(filters.state));
  if (filters.type) parts.push('type=' + encodeURIComponent(filters.type));
  if (filters.cf) parts.push('cf=' + encodeURIComponent(filters.cf));
  return parts.join('&');
}

router.get('/', async (req, res, next) => {
  try {
    const filters = parseListFilters(req.query);
    const { sql: whereSql, params } = buildSiteWhere(filters);

    const totalRows = await db.query(`SELECT COUNT(*) AS n FROM sites ${whereSql}`, params);
    const total = Number(totalRows[0]?.n || 0);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(filters.page, totalPages);
    const offset = (page - 1) * PAGE_SIZE;

    const sites = await db.query(
      `SELECT * FROM sites ${whereSql} ORDER BY name ASC LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params
    );

    const enriched = await Promise.all(
      sites.map(async (s) => {
        const [last, pct] = await Promise.all([stats.lastCheck(s.id), stats.uptimePct(s.id, 24)]);
        return { ...s, last_check: last, uptime24: pct };
      })
    );

    res.render('dashboard', {
      title: 'Dashboard',
      sites: enriched,
      filters,
      total,
      page,
      pageSize: PAGE_SIZE,
      totalPages,
      qsExceptPage: qsExceptPage(filters),
      hasFilters: Boolean(filters.q || filters.state || filters.type || filters.cf),
      publicBaseUrl: config.publicBaseUrl,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/api/sites', async (req, res, next) => {
  try {
    const idsRaw = String(req.query.ids || '');
    const ids = idsRaw
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 100);

    let sites;
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      sites = await db.query(
        `SELECT id, name, current_state, paused, monitor_type, last_heartbeat_at
           FROM sites WHERE id IN (${placeholders}) ORDER BY id ASC`,
        ids
      );
    } else {
      sites = await db.query(
        `SELECT id, name, current_state, paused, monitor_type, last_heartbeat_at
           FROM sites ORDER BY id ASC LIMIT 100`
      );
    }
    const lasts = await Promise.all(sites.map((s) => stats.lastCheck(s.id)));
    res.json(
      sites.map((s, i) => ({
        id: s.id,
        name: s.name,
        state: s.paused ? 'paused' : s.current_state,
        monitor_type: s.monitor_type,
        last_check: lasts[i],
        last_heartbeat_at: s.last_heartbeat_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.get('/sites/new', async (req, res, next) => {
  try {
    const allChannels = await channels.listChannels();
    res.render('site-form', {
      title: 'New monitor',
      site: {
        monitor_type: 'active',
        method: 'GET',
        interval_seconds: 60,
        timeout_ms: 10000,
        heartbeat_grace_seconds: 60,
        failure_threshold: 1,
        check_type: 'status',
        expected_status: '200',
        cloudflare_mode: 0,
        paused: 0,
      },
      allChannels,
      selectedChannelIds: [],
      formAction: '/sites',
      submitLabel: 'Create monitor',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/sites', async (req, res, next) => {
  try {
    const data = buildPayload(req.body);
    const channelIds = pickChannelIds(req.body);
    const heartbeat_token = data.monitor_type === 'heartbeat' ? crypto.randomBytes(16).toString('hex') : null;
    const result = await db.query(
      `INSERT INTO sites
         (name, url, monitor_type, method, interval_seconds, timeout_ms,
          check_type, expected_status, expected_string, json_path, expected_json_value,
          request_headers, failure_threshold, heartbeat_token, heartbeat_grace_seconds,
          cloudflare_mode, paused)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.name, data.url, data.monitor_type, data.method, data.interval_seconds, data.timeout_ms,
        data.check_type, data.expected_status, data.expected_string, data.json_path, data.expected_json_value,
        data.request_headers ? JSON.stringify(data.request_headers) : null,
        data.failure_threshold, heartbeat_token, data.heartbeat_grace_seconds,
        data.cloudflare_mode, data.paused,
      ]
    );
    const id = result.insertId;
    await channels.setSiteChannels(id, channelIds);
    logger.info({ siteId: id, name: data.name, monitor_type: data.monitor_type, channelIds }, 'sites.created');
    await monitor.reloadSite(id);
    req.flash('success', `Monitor "${data.name}" created`);
    res.redirect(`/sites/${id}`);
  } catch (err) {
    if (err.message?.startsWith('Invalid JSON')) {
      req.flash('error', err.message);
      return res.redirect('/sites/new');
    }
    next(err);
  }
});

router.get('/sites/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rows = await db.query(`SELECT * FROM sites WHERE id = ?`, [id]);
    const site = rows[0];
    if (!site) return res.status(404).render('error', { title: 'Not found', error: 'Site not found' });

    const [up24, up7, up30, rt24, rtAll, recent, incidents, downtime24, last, attachedChannels] = await Promise.all([
      stats.uptimePct(id, 24),
      stats.uptimePct(id, 24 * 7),
      stats.uptimePct(id, 24 * 30),
      stats.responseTimeStats(id, 24),
      stats.responseTimeStats(id, 24 * 30),
      stats.recentChecks(id, 50),
      stats.recentIncidents(id, 25),
      stats.totalDowntimeSeconds(id, 24),
      stats.lastCheck(id),
      channels.loadSiteChannels(id),
    ]);

    res.render('site-detail', {
      title: site.name,
      site,
      up24, up7, up30,
      rt24, rtAll,
      recent, incidents,
      downtime24, last,
      attachedChannels,
      publicBaseUrl: config.publicBaseUrl,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/sites/:id/edit', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rows = await db.query(`SELECT * FROM sites WHERE id = ?`, [id]);
    const site = rows[0];
    if (!site) return res.status(404).render('error', { title: 'Not found', error: 'Site not found' });
    let rh = site.request_headers;
    if (typeof rh === 'string' && rh.trim()) {
      try { rh = JSON.parse(rh); } catch { rh = null; }
    }
    site.request_headers_str = (rh && typeof rh === 'object' && !Array.isArray(rh))
      ? JSON.stringify(rh, null, 2)
      : '';
    const [allChannels, selectedChannelIds] = await Promise.all([
      channels.listChannels(),
      channels.listSiteChannelIds(id),
    ]);
    res.render('site-form', {
      title: `Edit ${site.name}`,
      site,
      allChannels,
      selectedChannelIds,
      formAction: `/sites/${id}/edit`,
      submitLabel: 'Save changes',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/sites/:id/edit', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = buildPayload(req.body);
    const channelIds = pickChannelIds(req.body);
    await db.query(
      `UPDATE sites SET
         name=?, url=?, monitor_type=?, method=?, interval_seconds=?, timeout_ms=?,
         check_type=?, expected_status=?, expected_string=?, json_path=?, expected_json_value=?,
         request_headers=?, failure_threshold=?, heartbeat_grace_seconds=?,
         cloudflare_mode=?, paused=?
       WHERE id=?`,
      [
        data.name, data.url, data.monitor_type, data.method, data.interval_seconds, data.timeout_ms,
        data.check_type, data.expected_status, data.expected_string, data.json_path, data.expected_json_value,
        data.request_headers ? JSON.stringify(data.request_headers) : null,
        data.failure_threshold, data.heartbeat_grace_seconds,
        data.cloudflare_mode, data.paused, id,
      ]
    );
    if (data.monitor_type === 'heartbeat') {
      const cur = await db.query(`SELECT heartbeat_token FROM sites WHERE id=?`, [id]);
      if (!cur[0]?.heartbeat_token) {
        await db.query(`UPDATE sites SET heartbeat_token=? WHERE id=?`, [crypto.randomBytes(16).toString('hex'), id]);
      }
    }
    await channels.setSiteChannels(id, channelIds);
    logger.info({ siteId: id, name: data.name, channelIds }, 'sites.updated');
    await monitor.reloadSite(id);
    req.flash('success', 'Monitor updated');
    res.redirect(`/sites/${id}`);
  } catch (err) {
    if (err.message?.startsWith('Invalid JSON')) {
      req.flash('error', err.message);
      return res.redirect(`/sites/${req.params.id}/edit`);
    }
    next(err);
  }
});

router.post('/sites/:id/delete', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    monitor.stopSite(id);
    await db.query(`DELETE FROM sites WHERE id=?`, [id]);
    logger.info({ siteId: id }, 'sites.deleted');
    req.flash('success', 'Monitor deleted');
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/sites/:id/pause', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rows = await db.query(`SELECT paused FROM sites WHERE id=?`, [id]);
    if (!rows.length) return res.redirect('/');
    const next = rows[0].paused ? 0 : 1;
    await db.query(`UPDATE sites SET paused=? WHERE id=?`, [next, id]);
    await monitor.reloadSite(id);
    logger.info({ siteId: id, paused: next }, 'sites.toggled_pause');
    req.flash('success', next ? 'Monitor paused' : 'Monitor resumed');
    res.redirect(`/sites/${id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/sites/:id/check-now', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await monitor.checkNow(id);
    logger.info({ siteId: id, result }, 'sites.manual_check');
    req.flash(
      result.isUp === 1 ? 'success' : result.isUp === 0 ? 'error' : 'warning',
      result.isUp === 1
        ? `Check passed (${result.responseTimeMs ?? '-'}ms)`
        : result.isUp === 0
        ? `Check failed: ${result.errorMessage || 'unknown'}`
        : `Inconclusive: ${result.errorMessage || 'cloudflare challenge'}`
    );
    res.redirect(`/sites/${id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/api/sites/:id/timeseries', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const hours = Math.min(720, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const bucket = hours <= 6 ? 1 : hours <= 24 ? 5 : hours <= 72 ? 15 : 60;
    const data = await stats.timeseries(id, hours, bucket);
    res.json({ hours, bucketMinutes: bucket, points: data });
  } catch (err) {
    next(err);
  }
});

router.post('/theme', (req, res) => {
  const next = req.body.theme === 'dark' ? 'dark' : 'light';
  res.cookie('theme', next, { httpOnly: false, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 365 });
  res.json({ ok: true, theme: next });
});

module.exports = router;
