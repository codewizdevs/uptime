'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const monitor = require('../monitor');
const stats = require('../lib/stats');
const channels = require('../lib/channels');
const config = require('../config');
const logger = require('../logger');
const { idParam, parseId } = require('../lib/ids');
const maintenance = require('../lib/maintenance');
const tagsLib = require('../lib/tags');
const audit = require('../lib/audit');
const acl = require('../lib/acl');
const users = require('../lib/users');
const grants = require('../lib/grants');

const router = express.Router();
router.param('id', idParam);

const VALID_MONITOR_TYPES = ['active', 'heartbeat', 'cert', 'tcp', 'ping', 'dns', 'domain'];

// Domain WHOIS/RDAP probes shouldn't hit registries more often than ~daily.
// Registries rate-limit aggressively (some at 1/10s/IP) and expiry data
// changes once per year. We clamp at 12h regardless of what the form sent.
const DOMAIN_MIN_INTERVAL_SECONDS = 12 * 60 * 60;
const DOMAIN_DEFAULT_INTERVAL_SECONDS = 24 * 60 * 60;
const VALID_CHECK_TYPES = ['status', 'string', 'regex', 'json'];
const VALID_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const VALID_DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'SOA', 'PTR'];

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

  // Per-type interval floors. Domain probes are clamped to 12h regardless of
  // what the form sends — registries throttle harder than that and expiry
  // dates change once a year.
  let enforced_interval;
  if (monitor_type === 'domain') {
    const raw = parseInt(body.interval_seconds, 10);
    enforced_interval = Math.max(
      DOMAIN_MIN_INTERVAL_SECONDS,
      Number.isFinite(raw) && raw > 0 ? raw : DOMAIN_DEFAULT_INTERVAL_SECONDS
    );
  } else if (monitor_type === 'active' && cloudflare_mode) {
    enforced_interval = Math.max(60, interval_seconds);
  } else {
    enforced_interval = interval_seconds;
  }

  const display_name = (body.display_name || '').trim().slice(0, 255) || null;
  const status_page_group = (body.status_page_group || '').trim().slice(0, 120) || null;
  const status_page_excluded = body.status_page_excluded === '1' || body.status_page_excluded === 'on' ? 1 : 0;
  const status_page_order = Math.max(0, parseInt(body.status_page_order, 10) || 0);

  const cert_expiry_warn_days = Math.max(0, Math.min(365, parseInt(body.cert_expiry_warn_days, 10)));
  const cert_host = monitor_type === 'cert' ? (body.cert_host || '').trim().slice(0, 255) : null;
  const cert_port = monitor_type === 'cert' ? Math.max(1, Math.min(65535, parseInt(body.cert_port, 10) || 443)) : null;

  const tcp_host = monitor_type === 'tcp' ? (body.tcp_host || '').trim().slice(0, 255) : null;
  const tcp_port = monitor_type === 'tcp' ? Math.max(1, Math.min(65535, parseInt(body.tcp_port, 10) || 0)) : null;

  const ping_host = monitor_type === 'ping' ? (body.ping_host || '').trim().slice(0, 255) : null;
  const ping_count = monitor_type === 'ping'
    ? Math.max(1, Math.min(10, parseInt(body.ping_count, 10) || 1))
    : 1;

  const rawDnsType = String(body.dns_record_type || 'A').toUpperCase();
  const dns_query = monitor_type === 'dns' ? (body.dns_query || '').trim().slice(0, 255) : null;
  const dns_record_type = monitor_type === 'dns'
    ? (VALID_DNS_TYPES.includes(rawDnsType) ? rawDnsType : 'A')
    : null;
  const dns_resolver = monitor_type === 'dns' ? (body.dns_resolver || '').trim().slice(0, 255) || null : null;
  const dns_expected = monitor_type === 'dns' ? (body.dns_expected || '').slice(0, 1024) || null : null;

  // Domain (WHOIS/RDAP) fields. Strip schemes / paths / www. defensively
  // so users can paste a URL and still get a usable apex domain.
  const whois_domain = monitor_type === 'domain'
    ? String(body.whois_domain || '').trim().toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '')
        .replace(/^www\./, '')
        .slice(0, 255) || null
    : null;
  const domain_expiry_warn_days_raw = parseInt(body.domain_expiry_warn_days, 10);
  const domain_expiry_warn_days = Number.isFinite(domain_expiry_warn_days_raw)
    ? Math.max(0, Math.min(365, domain_expiry_warn_days_raw))
    : 30;

  // Phase 10 — per-monitor probe options (active monitors only).
  const VALID_BODY_TYPES = ['text', 'json', 'form'];
  const VALID_AUTH_TYPES = ['none', 'basic', 'bearer'];
  const isActive = monitor_type === 'active';
  const request_body = isActive ? (body.request_body || '').slice(0, 64 * 1024) || null : null;
  const request_body_type = isActive && VALID_BODY_TYPES.includes(body.request_body_type)
    ? body.request_body_type : 'text';
  const auth_type = isActive && VALID_AUTH_TYPES.includes(body.auth_type) ? body.auth_type : 'none';
  const auth_username = isActive && auth_type === 'basic'
    ? (body.auth_username || '').slice(0, 255) || null
    : null;
  const auth_password = isActive && auth_type === 'basic'
    ? (body.auth_password || '').slice(0, 255) || null
    : null;
  const auth_token = isActive && auth_type === 'bearer'
    ? (body.auth_token || '').slice(0, 1024) || null
    : null;
  const follow_redirects = isActive && body.follow_redirects === '0' ? 0 : 1;
  const skip_tls_verify = isActive && body.skip_tls_verify === '1' ? 1 : 0;
  const max_rt = parseInt(body.max_response_time_ms, 10);
  const max_response_time_ms = isActive && Number.isFinite(max_rt) && max_rt > 0
    ? Math.min(max_rt, 600000) : null;

  // Phase 11 — per-monitor notes (markdown) and mute-notifications toggle.
  const notes = (body.notes || '').slice(0, 16 * 1024) || null;
  const mute_notifications = body.mute_notifications === '1' ? 1 : 0;

  const heartbeat_schedule_kind = monitor_type === 'heartbeat' && body.heartbeat_schedule_kind === 'cron'
    ? 'cron' : 'interval';
  const heartbeat_cron = monitor_type === 'heartbeat' && heartbeat_schedule_kind === 'cron'
    ? (body.heartbeat_cron || '').trim().slice(0, 160) || null
    : null;
  const heartbeat_timezone = monitor_type === 'heartbeat' && heartbeat_schedule_kind === 'cron'
    ? (body.heartbeat_timezone || 'UTC').trim().slice(0, 64) || 'UTC'
    : null;

  // For TCP/ping/DNS the "string" check_type is meaningless at the routes
  // layer (the probe doesn't return a body), but we still let the user
  // supply an `expected_string` for TCP banner-match assertions.
  const expected_string =
    (monitor_type === 'active' && (check_type === 'string' || check_type === 'regex'))
      ? (body.expected_string || '')
      : monitor_type === 'tcp'
        ? (body.expected_banner || '').slice(0, 256) || null
        : null;

  return {
    name: (body.name || '').trim() || 'Untitled',
    url: monitor_type === 'active' ? (body.url || '').trim() : '',
    monitor_type,
    method,
    interval_seconds: enforced_interval,
    timeout_ms,
    check_type: monitor_type === 'active' ? check_type : null,
    expected_status: monitor_type === 'active' && check_type === 'status' ? (body.expected_status || '200').trim() : null,
    expected_string,
    json_path: monitor_type === 'active' && check_type === 'json' ? (body.json_path || '').trim() : null,
    expected_json_value: monitor_type === 'active' && check_type === 'json' ? (body.expected_json_value || '') : null,
    request_headers: monitor_type === 'active' ? parseHeadersJson(body.request_headers) : null,
    failure_threshold,
    heartbeat_grace_seconds,
    cloudflare_mode,
    paused,
    display_name,
    status_page_group,
    status_page_excluded,
    status_page_order,
    cert_expiry_warn_days: Number.isFinite(cert_expiry_warn_days) ? cert_expiry_warn_days : 14,
    cert_host,
    cert_port,
    tcp_host,
    tcp_port,
    ping_host,
    ping_count,
    dns_query,
    dns_record_type,
    dns_resolver,
    dns_expected,
    whois_domain,
    domain_expiry_warn_days,
    heartbeat_schedule_kind,
    heartbeat_cron,
    heartbeat_timezone,
    request_body,
    request_body_type,
    auth_type,
    auth_username,
    auth_password,
    auth_token,
    follow_redirects,
    skip_tls_verify,
    max_response_time_ms,
    notes,
    mute_notifications,
  };
}

function pickChannelIds(body) {
  let raw = body.channel_ids;
  if (!Array.isArray(raw)) raw = raw == null ? [] : [raw];
  return raw.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0);
}

function pickTagIds(body) {
  let raw = body.tag_ids;
  if (!Array.isArray(raw)) raw = raw == null ? [] : [raw];
  return raw.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0);
}

const PAGE_SIZE = 52;
const VALID_STATES = ['up', 'down', 'unknown', 'paused'];
const VALID_TYPES = ['active', 'heartbeat', 'cert', 'tcp', 'ping', 'dns'];

function parseListFilters(query) {
  const q = String(query.q || '').trim().slice(0, 120);
  const stateRaw = String(query.state || '').trim().toLowerCase();
  const typeRaw = String(query.type || '').trim().toLowerCase();
  const cfRaw = String(query.cf || '').trim().toLowerCase();
  const state = VALID_STATES.includes(stateRaw) ? stateRaw : '';
  const type = VALID_TYPES.includes(typeRaw) ? typeRaw : '';
  const cf = cfRaw === 'on' || cfRaw === 'off' ? cfRaw : '';
  const tagId = parseInt(query.tag, 10);
  const tag = Number.isFinite(tagId) && tagId > 0 ? tagId : '';
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { q, state, type, cf, tag, page };
}

function buildSiteWhere(filters, user) {
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
  if (filters.tag) {
    where.push('id IN (SELECT site_id FROM site_tags WHERE tag_id = ?)');
    params.push(filters.tag);
  }
  // Per-monitor ACL — admins get 1=1, everyone else owner|grant.
  const aclClause = acl.siteFilterClause(user);
  if (aclClause.sql && aclClause.sql !== '1 = 1') {
    where.push(aclClause.sql);
    params.push(...aclClause.params);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function qsExceptPage(filters) {
  const parts = [];
  if (filters.q) parts.push('q=' + encodeURIComponent(filters.q));
  if (filters.state) parts.push('state=' + encodeURIComponent(filters.state));
  if (filters.type) parts.push('type=' + encodeURIComponent(filters.type));
  if (filters.cf) parts.push('cf=' + encodeURIComponent(filters.cf));
  if (filters.tag) parts.push('tag=' + encodeURIComponent(filters.tag));
  return parts.join('&');
}

router.get('/', async (req, res, next) => {
  try {
    const filters = parseListFilters(req.query);
    const { sql: whereSql, params } = buildSiteWhere(filters, req.session.user);

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

    // Tag chips on each card
    const tagsBySite = await tagsLib.tagsForSites(enriched.map((s) => s.id));
    enriched.forEach((s) => { s.tags = tagsBySite.get(s.id) || []; });

    // Per-card manage flag. Admins always manage; otherwise we attach a flag
    // for owner-or-manage-grant. This drives whether the delete-pill on each
    // card is rendered.
    const isAdminUser = acl.isAdmin(req.session.user);
    if (isAdminUser) {
      enriched.forEach((s) => { s.canManage = true; });
    } else {
      const uid = req.session.user?.id;
      const manageRows = enriched.length
        ? await db.query(
            `SELECT site_id FROM site_grants
              WHERE user_id = ? AND permission = 'manage'
                AND site_id IN (${enriched.map(() => '?').join(',')})`,
            [uid, ...enriched.map((s) => s.id)]
          )
        : [];
      const manageSet = new Set(manageRows.map((r) => Number(r.site_id)));
      enriched.forEach((s) => {
        s.canManage = (s.owner_user_id != null && s.owner_user_id === uid) || manageSet.has(s.id);
      });
    }

    // Surface active maintenance windows so users know why no alerts are firing.
    const now = new Date();
    const allWindows = await maintenance.listWindows();
    const activeWindows = allWindows
      .filter((w) => maintenance.windowIsActive(w, now))
      .map((w) => ({
        ...w,
        ends_at_display: maintenance.currentEnd(w, now)?.toISOString() || null,
      }));

    const allTags = await tagsLib.listTags();
    const activeTag = filters.tag ? allTags.find((t) => t.id === filters.tag) || null : null;

    res.render('dashboard', {
      title: 'Dashboard',
      sites: enriched,
      filters,
      total,
      page,
      pageSize: PAGE_SIZE,
      totalPages,
      qsExceptPage: qsExceptPage(filters),
      hasFilters: Boolean(filters.q || filters.state || filters.type || filters.cf || filters.tag),
      publicBaseUrl: config.publicBaseUrl,
      activeMaintenance: activeWindows,
      allTags,
      activeTag,
      isAdmin: acl.isAdmin(req.session.user),
      canCreate: acl.isAdmin(req.session.user) || req.session.user?.role === 'editor',
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

    const aclClause = acl.siteFilterClause(req.session.user);
    const isAdminQuery = aclClause.sql === '1 = 1';

    let sites;
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const sql = `SELECT id, name, current_state, paused, monitor_type, last_heartbeat_at
                     FROM sites WHERE id IN (${placeholders})
                     ${isAdminQuery ? '' : ' AND ' + aclClause.sql}
                     ORDER BY id ASC`;
      sites = await db.query(sql, isAdminQuery ? ids : [...ids, ...aclClause.params]);
    } else {
      const sql = `SELECT id, name, current_state, paused, monitor_type, last_heartbeat_at
                     FROM sites
                     ${isAdminQuery ? '' : 'WHERE ' + aclClause.sql}
                     ORDER BY id ASC LIMIT 100`;
      sites = await db.query(sql, isAdminQuery ? [] : aclClause.params);
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

router.get('/sites/new', acl.requireRole('admin', 'editor'), async (req, res, next) => {
  try {
    const [allChannels, allTags] = await Promise.all([
      channels.listChannels(),
      tagsLib.listTags(),
    ]);
    // Owner picker is admin-only; everyone else owns what they create.
    let allOwners = [];
    if (acl.isAdmin(req.session.user)) {
      allOwners = await users.list();
    }
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
        owner_user_id: req.session.user?.id || null,
      },
      allChannels,
      selectedChannelIds: [],
      allTags,
      selectedTagIds: [],
      allOwners,
      isAdmin: acl.isAdmin(req.session.user),
      formAction: '/sites',
      submitLabel: 'Create monitor',
      CHANNEL_META: channels.CHANNEL_META,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/sites', acl.requireRole('admin', 'editor'), async (req, res, next) => {
  try {
    const data = buildPayload(req.body);
    const channelIds = pickChannelIds(req.body);
    const heartbeat_token = data.monitor_type === 'heartbeat' ? crypto.randomBytes(16).toString('hex') : null;
    // Owner: admins may pick; everyone else implicitly owns their own.
    let ownerUserId = req.session.user?.id || null;
    if (acl.isAdmin(req.session.user)) {
      const raw = parseId(req.body.owner_user_id);
      if (raw != null) ownerUserId = raw;
      else if (req.body.owner_user_id === '' || req.body.owner_user_id === '0') ownerUserId = null;
      else ownerUserId = req.session.user?.id || null;
    }
    const result = await db.query(
      `INSERT INTO sites
         (name, url, monitor_type, method, interval_seconds, timeout_ms,
          check_type, expected_status, expected_string, json_path, expected_json_value,
          request_headers, failure_threshold, heartbeat_token, heartbeat_grace_seconds,
          cloudflare_mode, paused,
          display_name, status_page_group, status_page_excluded, status_page_order,
          cert_expiry_warn_days, cert_host, cert_port,
          tcp_host, tcp_port, ping_host, ping_count,
          dns_query, dns_record_type, dns_resolver, dns_expected,
          whois_domain, domain_expiry_warn_days,
          heartbeat_schedule_kind, heartbeat_cron, heartbeat_timezone,
          request_body, request_body_type,
          auth_type, auth_username, auth_password, auth_token,
          follow_redirects, skip_tls_verify, max_response_time_ms,
          notes, mute_notifications, owner_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.name, data.url, data.monitor_type, data.method, data.interval_seconds, data.timeout_ms,
        data.check_type, data.expected_status, data.expected_string, data.json_path, data.expected_json_value,
        data.request_headers ? JSON.stringify(data.request_headers) : null,
        data.failure_threshold, heartbeat_token, data.heartbeat_grace_seconds,
        data.cloudflare_mode, data.paused,
        data.display_name, data.status_page_group, data.status_page_excluded, data.status_page_order,
        data.cert_expiry_warn_days, data.cert_host, data.cert_port,
        data.tcp_host, data.tcp_port, data.ping_host, data.ping_count,
        data.dns_query, data.dns_record_type, data.dns_resolver, data.dns_expected,
        data.whois_domain, data.domain_expiry_warn_days,
        data.heartbeat_schedule_kind, data.heartbeat_cron, data.heartbeat_timezone,
        data.request_body, data.request_body_type,
        data.auth_type, data.auth_username, data.auth_password, data.auth_token,
        data.follow_redirects, data.skip_tls_verify, data.max_response_time_ms,
        data.notes, data.mute_notifications, ownerUserId,
      ]
    );
    const id = result.insertId;
    await channels.setSiteChannels(id, channelIds);
    await tagsLib.setSiteTags(id, pickTagIds(req.body));
    audit.fromReq(req, 'site.created', { targetType: 'site', targetId: id, meta: { name: data.name, monitor_type: data.monitor_type } });
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

router.get('/sites/:id', acl.requireSiteSee, async (req, res, next) => {
  try {
    const site = req.site;
    const id = site.id;

    const [up24, up7, up30, rt24, rtAll, recent, incidents, downtime24, last, attachedChannels, siteTagRows] = await Promise.all([
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
      tagsLib.listSiteTags(id),
    ]);

    let recentPings = [];
    if (site.monitor_type === 'heartbeat') {
      recentPings = await db.query(
        `SELECT id, kind, exit_code, duration_ms, body, source_ip, user_agent, received_at
           FROM heartbeat_pings
          WHERE site_id = ?
          ORDER BY id DESC LIMIT 25`,
        [id]
      );
    }

    const canManage = await acl.canManageSite(req.session.user, site);
    const canShare = canManage && (acl.isAdmin(req.session.user) || site.owner_user_id === req.session.user.id);
    let ownerUser = null;
    let siteGrants = [];
    let eligibleUsers = [];
    if (canShare) {
      if (site.owner_user_id != null) ownerUser = await users.getById(site.owner_user_id);
      siteGrants = await grants.listForSite(id);
      const allUsers = await users.list();
      const grantedIds = new Set(siteGrants.map((g) => g.user_id));
      eligibleUsers = allUsers.filter((u) => !u.disabled
        && u.id !== site.owner_user_id
        && !grantedIds.has(u.id));
    }

    res.render('site-detail', {
      title: site.name,
      site,
      up24, up7, up30,
      rt24, rtAll,
      recent, incidents,
      downtime24, last,
      attachedChannels,
      siteTags: siteTagRows,
      recentPings,
      publicBaseUrl: config.publicBaseUrl,
      canManage,
      canShare,
      isAdmin: acl.isAdmin(req.session.user),
      ownerUser,
      siteGrants,
      eligibleUsers,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/sites/:id/edit', acl.requireSiteManage, async (req, res, next) => {
  try {
    const site = req.site;
    const id = site.id;
    let rh = site.request_headers;
    if (typeof rh === 'string' && rh.trim()) {
      try { rh = JSON.parse(rh); } catch { rh = null; }
    }
    site.request_headers_str = (rh && typeof rh === 'object' && !Array.isArray(rh))
      ? JSON.stringify(rh, null, 2)
      : '';
    const [allChannels, selectedChannelIds, allTags, siteTagRows] = await Promise.all([
      channels.listChannels(),
      channels.listSiteChannelIds(id),
      tagsLib.listTags(),
      tagsLib.listSiteTags(id),
    ]);
    const selectedTagIds = siteTagRows.map((t) => t.id);
    let allOwners = [];
    if (acl.isAdmin(req.session.user)) allOwners = await users.list();
    res.render('site-form', {
      title: `Edit ${site.name}`,
      site,
      allChannels,
      selectedChannelIds,
      allTags,
      selectedTagIds,
      allOwners,
      isAdmin: acl.isAdmin(req.session.user),
      formAction: `/sites/${id}/edit`,
      submitLabel: 'Save changes',
      CHANNEL_META: channels.CHANNEL_META,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/sites/:id/edit', acl.requireSiteManage, async (req, res, next) => {
  try {
    const id = req.site.id;
    const data = buildPayload(req.body);
    const channelIds = pickChannelIds(req.body);
    await db.query(
      `UPDATE sites SET
         name=?, url=?, monitor_type=?, method=?, interval_seconds=?, timeout_ms=?,
         check_type=?, expected_status=?, expected_string=?, json_path=?, expected_json_value=?,
         request_headers=?, failure_threshold=?, heartbeat_grace_seconds=?,
         cloudflare_mode=?, paused=?,
         display_name=?, status_page_group=?, status_page_excluded=?, status_page_order=?,
         cert_expiry_warn_days=?, cert_host=?, cert_port=?,
         tcp_host=?, tcp_port=?, ping_host=?, ping_count=?,
         dns_query=?, dns_record_type=?, dns_resolver=?, dns_expected=?,
         whois_domain=?, domain_expiry_warn_days=?,
         heartbeat_schedule_kind=?, heartbeat_cron=?, heartbeat_timezone=?,
         request_body=?, request_body_type=?,
         auth_type=?, auth_username=?, auth_password=?, auth_token=?,
         follow_redirects=?, skip_tls_verify=?, max_response_time_ms=?,
         notes=?, mute_notifications=?
       WHERE id=?`,
      [
        data.name, data.url, data.monitor_type, data.method, data.interval_seconds, data.timeout_ms,
        data.check_type, data.expected_status, data.expected_string, data.json_path, data.expected_json_value,
        data.request_headers ? JSON.stringify(data.request_headers) : null,
        data.failure_threshold, data.heartbeat_grace_seconds,
        data.cloudflare_mode, data.paused,
        data.display_name, data.status_page_group, data.status_page_excluded, data.status_page_order,
        data.cert_expiry_warn_days, data.cert_host, data.cert_port,
        data.tcp_host, data.tcp_port, data.ping_host, data.ping_count,
        data.dns_query, data.dns_record_type, data.dns_resolver, data.dns_expected,
        data.whois_domain, data.domain_expiry_warn_days,
        data.heartbeat_schedule_kind, data.heartbeat_cron, data.heartbeat_timezone,
        data.request_body, data.request_body_type,
        data.auth_type, data.auth_username, data.auth_password, data.auth_token,
        data.follow_redirects, data.skip_tls_verify, data.max_response_time_ms,
        data.notes, data.mute_notifications,
        id,
      ]
    );

    // Clear the domain-alerted band whenever the user changes the warn-days
    // threshold or moves to a different domain — otherwise tightening the
    // threshold or pointing at a new domain would suppress the first alert.
    if (data.monitor_type === 'domain') {
      await db.query(`UPDATE sites SET domain_alerted_at_days = NULL WHERE id = ?`, [id]);
    }
    // Owner reassignment is admin-only; viewers/editors can't change ownership
    // even when granted manage on the monitor.
    if (acl.isAdmin(req.session.user) && Object.prototype.hasOwnProperty.call(req.body, 'owner_user_id')) {
      let ownerUserId = null;
      const raw = parseId(req.body.owner_user_id);
      if (raw != null) ownerUserId = raw;
      await db.query(`UPDATE sites SET owner_user_id = ? WHERE id = ?`, [ownerUserId, id]);
    }
    if (data.monitor_type === 'heartbeat') {
      const cur = await db.query(`SELECT heartbeat_token FROM sites WHERE id=?`, [id]);
      if (!cur[0]?.heartbeat_token) {
        await db.query(`UPDATE sites SET heartbeat_token=? WHERE id=?`, [crypto.randomBytes(16).toString('hex'), id]);
      }
    }
    await channels.setSiteChannels(id, channelIds);
    await tagsLib.setSiteTags(id, pickTagIds(req.body));
    audit.fromReq(req, 'site.updated', { targetType: 'site', targetId: id, meta: { name: data.name } });
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

router.post('/sites/:id/delete', acl.requireSiteManage, async (req, res, next) => {
  try {
    const id = req.site.id;
    monitor.stopSite(id);
    await db.query(`DELETE FROM sites WHERE id=?`, [id]);
    // Tidy up dangling grants (no FK on SQLite).
    await db.query(`DELETE FROM site_grants WHERE site_id=?`, [id]);
    audit.fromReq(req, 'site.deleted', { targetType: 'site', targetId: id });
    logger.info({ siteId: id }, 'sites.deleted');
    req.flash('success', 'Monitor deleted');
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/sites/:id/pause', acl.requireSiteManage, async (req, res, next) => {
  try {
    const id = req.site.id;
    const nextVal = req.site.paused ? 0 : 1;
    await db.query(`UPDATE sites SET paused=? WHERE id=?`, [nextVal, id]);
    await monitor.reloadSite(id);
    logger.info({ siteId: id, paused: nextVal }, 'sites.toggled_pause');
    req.flash('success', nextVal ? 'Monitor paused' : 'Monitor resumed');
    res.redirect(`/sites/${id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/sites/:id/check-now', acl.requireSiteManage, async (req, res, next) => {
  try {
    const id = req.site.id;
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

router.get('/api/sites/:id/timeseries', acl.requireSiteSee, async (req, res, next) => {
  try {
    const id = req.site.id;
    const hours = Math.min(720, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const bucket = hours <= 6 ? 1 : hours <= 24 ? 5 : hours <= 72 ? 15 : 60;
    const data = await stats.timeseries(id, hours, bucket);
    res.json({ hours, bucketMinutes: bucket, points: data });
  } catch (err) {
    next(err);
  }
});

// ─── CSV export helpers ──────────────────────────────────────────────────
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(headers, rows) {
  const out = [headers.join(',')];
  for (const r of rows) out.push(headers.map((h) => csvCell(r[h])).join(','));
  return out.join('\n') + '\n';
}

router.get('/sites/:id/checks.csv', acl.requireSiteSee, async (req, res, next) => {
  try {
    const id = req.site.id;
    const limit = Math.min(50000, Math.max(1, parseInt(req.query.limit, 10) || 5000));
    const rows = await db.query(
      `SELECT id, site_id, is_up, status_code, response_time_ms, error_message, checked_at
         FROM checks WHERE site_id = ? ORDER BY id DESC LIMIT ${limit}`,
      [id]
    );
    const csv = rowsToCsv(
      ['id', 'site_id', 'is_up', 'status_code', 'response_time_ms', 'error_message', 'checked_at'],
      rows
    );
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="site-${id}-checks.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

router.get('/sites/:id/incidents.csv', acl.requireSiteSee, async (req, res, next) => {
  try {
    const id = req.site.id;
    const rows = await db.query(
      `SELECT id, site_id, started_at, ended_at, last_error, during_maintenance,
              ${db.diffSecondsSql('started_at', 'COALESCE(ended_at, ' + db.nowMs() + ')')} AS duration_seconds
         FROM incidents WHERE site_id = ? ORDER BY id DESC`,
      [id]
    );
    const csv = rowsToCsv(
      ['id', 'site_id', 'started_at', 'ended_at', 'duration_seconds', 'during_maintenance', 'last_error'],
      rows
    );
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="site-${id}-incidents.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

router.get('/incidents.csv', async (req, res, next) => {
  try {
    // Non-admins get filtered to visible sites; admins see everything.
    const aclClause = acl.siteFilterClause(req.session.user, { table: 's' });
    const sql = `SELECT i.id, i.site_id, s.name AS site_name, i.started_at, i.ended_at, i.last_error, i.during_maintenance,
              ${db.diffSecondsSql('i.started_at', 'COALESCE(i.ended_at, ' + db.nowMs() + ')')} AS duration_seconds
         FROM incidents i JOIN sites s ON s.id = i.site_id
        WHERE ${aclClause.sql}
        ORDER BY i.id DESC`;
    const rows = await db.query(sql, aclClause.params);
    const csv = rowsToCsv(
      ['id', 'site_id', 'site_name', 'started_at', 'ended_at', 'duration_seconds', 'during_maintenance', 'last_error'],
      rows
    );
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="incidents.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

// Bulk actions invoked from the dashboard. Accepts:
//   action     ∈ pause | resume | delete | tag_add | tag_remove
//   site_ids[] = array of integer site IDs
//   tag_id     = integer (only for tag_add / tag_remove)
const BULK_ACTIONS = new Set(['pause', 'resume', 'delete', 'tag_add', 'tag_remove']);

router.post('/sites/bulk', acl.requireRole('admin', 'editor'), async (req, res, next) => {
  try {
    const action = String(req.body.action || '').toLowerCase();
    if (!BULK_ACTIONS.has(action)) {
      req.flash('error', `Unknown bulk action: ${action}`);
      return res.redirect('/');
    }
    let raw = req.body.site_ids;
    if (!Array.isArray(raw)) raw = raw == null ? [] : [raw];
    const requestedIds = raw
      .map((v) => parseId(v))
      .filter((v) => v != null);
    if (!requestedIds.length) {
      req.flash('warning', 'No monitors selected');
      return res.redirect(req.body.return_to && req.body.return_to.startsWith('/') ? req.body.return_to : '/');
    }
    // Filter to only the sites this user may manage. Skipped ones get
    // reported back in the flash.
    let siteIds = requestedIds;
    let skipped = 0;
    if (!acl.isAdmin(req.session.user)) {
      const requestedPh = requestedIds.map(() => '?').join(',');
      const visible = await db.query(
        `SELECT id, owner_user_id FROM sites WHERE id IN (${requestedPh})`,
        requestedIds
      );
      const allowed = [];
      for (const r of visible) {
        if (await acl.canManageSite(req.session.user, r)) allowed.push(r.id);
      }
      skipped = requestedIds.length - allowed.length;
      siteIds = allowed;
    }
    if (!siteIds.length) {
      req.flash('error', 'You do not have permission to act on the selected monitors.');
      return res.redirect(req.body.return_to && req.body.return_to.startsWith('/') ? req.body.return_to : '/');
    }
    const ph = siteIds.map(() => '?').join(',');

    if (action === 'pause' || action === 'resume') {
      const v = action === 'pause' ? 1 : 0;
      await db.query(`UPDATE sites SET paused=? WHERE id IN (${ph})`, [v, ...siteIds]);
      for (const id of siteIds) await monitor.reloadSite(id);
      req.flash('success', `${action === 'pause' ? 'Paused' : 'Resumed'} ${siteIds.length} monitor${siteIds.length === 1 ? '' : 's'}`);
    } else if (action === 'delete') {
      for (const id of siteIds) monitor.stopSite(id);
      await db.query(`DELETE FROM sites WHERE id IN (${ph})`, siteIds);
      req.flash('success', `Deleted ${siteIds.length} monitor${siteIds.length === 1 ? '' : 's'}`);
    } else if (action === 'tag_add') {
      const tagId = parseId(req.body.tag_id);
      if (tagId == null) {
        req.flash('error', 'Pick a tag to add');
      } else {
        await tagsLib.attachToSites(siteIds, tagId);
        req.flash('success', `Tagged ${siteIds.length} monitor${siteIds.length === 1 ? '' : 's'}`);
      }
    } else if (action === 'tag_remove') {
      const tagId = parseId(req.body.tag_id);
      if (tagId == null) {
        req.flash('error', 'Pick a tag to remove');
      } else {
        await tagsLib.detachFromSites(siteIds, tagId);
        req.flash('success', `Removed tag from ${siteIds.length} monitor${siteIds.length === 1 ? '' : 's'}`);
      }
    }
    audit.fromReq(req, 'site.bulk_' + action, { meta: { ids: siteIds, count: siteIds.length, skipped } });
    logger.info({ action, count: siteIds.length, ids: siteIds, skipped }, 'sites.bulk_action');
    if (skipped > 0) {
      req.flash('warning', `${skipped} monitor${skipped === 1 ? '' : 's'} skipped (no permission)`);
    }
    res.redirect(req.body.return_to && req.body.return_to.startsWith('/') ? req.body.return_to : '/');
  } catch (err) {
    next(err);
  }
});

// ─── Sharing (per-monitor grants) ────────────────────────────────────────
// Visible to admins and the site owner. Editors with a 'manage' grant can
// edit the site itself but cannot reassign sharing.
function requireSharingAdmin(req, res, next) {
  const site = req.site;
  const u = req.session.user;
  if (!site || !u) return res.status(403).render('error', { title: 'Forbidden', error: 'You cannot manage sharing for this monitor.' });
  if (acl.isAdmin(u) || (site.owner_user_id != null && site.owner_user_id === u.id)) return next();
  return res.status(403).render('error', { title: 'Forbidden', error: 'Only the site owner or an admin can manage sharing.' });
}

router.post('/sites/:id/grants', acl.requireSiteManage, requireSharingAdmin, async (req, res, next) => {
  try {
    const site = req.site;
    const userId = parseId(req.body.user_id);
    const permission = String(req.body.permission || 'view').toLowerCase();
    if (userId == null) {
      req.flash('error', 'Pick a user to grant access to.');
      return res.redirect(`/sites/${site.id}`);
    }
    if (userId === req.session.user?.id) {
      req.flash('error', 'You already have access to your own monitors.');
      return res.redirect(`/sites/${site.id}`);
    }
    const target = await users.getById(userId);
    if (!target) {
      req.flash('error', 'Selected user no longer exists.');
      return res.redirect(`/sites/${site.id}`);
    }
    await grants.set(site.id, userId, permission, req.session.user?.id || null);
    audit.fromReq(req, 'site.grant_set', { targetType: 'site', targetId: site.id, meta: { user_id: userId, permission } });
    req.flash('success', `Granted ${permission} to ${target.username}`);
    res.redirect(`/sites/${site.id}`);
  } catch (err) { next(err); }
});

router.post('/sites/:id/grants/:userId/delete', acl.requireSiteManage, requireSharingAdmin, async (req, res, next) => {
  try {
    const site = req.site;
    const userId = parseId(req.params.userId);
    if (userId == null) return res.redirect(`/sites/${site.id}`);
    await grants.revoke(site.id, userId);
    audit.fromReq(req, 'site.grant_revoked', { targetType: 'site', targetId: site.id, meta: { user_id: userId } });
    req.flash('success', 'Access revoked');
    res.redirect(`/sites/${site.id}`);
  } catch (err) { next(err); }
});

router.post('/theme', (req, res) => {
  const next = req.body.theme === 'dark' ? 'dark' : 'light';
  res.cookie('theme', next, { httpOnly: false, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 365 });
  res.json({ ok: true, theme: next });
});

module.exports = router;
