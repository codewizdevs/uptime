'use strict';

const crypto = require('crypto');
const db = require('../db');
const channels = require('./channels');
const monitor = require('../monitor');
const logger = require('../logger');

const BACKUP_VERSION = 1;
const BACKUP_APP = 'uptime';

const SITE_EXPORT_FIELDS = [
  'name', 'url', 'monitor_type', 'method', 'interval_seconds', 'timeout_ms',
  'check_type', 'expected_status', 'expected_string', 'json_path', 'expected_json_value',
  'request_headers', 'failure_threshold', 'heartbeat_token', 'heartbeat_grace_seconds',
  'cloudflare_mode', 'paused',
];

const VALID_MONITOR_TYPES = ['active', 'heartbeat'];
const VALID_CHECK_TYPES = ['status', 'string', 'json'];
const VALID_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const VALID_CHANNEL_TYPES = channels.CHANNEL_TYPES;
const VALID_CONFLICT = ['skip', 'replace', 'rename'];

function normalizeSiteRow(row) {
  const out = {};
  for (const f of SITE_EXPORT_FIELDS) {
    let v = row[f];
    if (f === 'request_headers') {
      if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch { v = null; }
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) v = null;
    }
    if (f === 'cloudflare_mode' || f === 'paused') v = v ? 1 : 0;
    if (v === undefined) v = null;
    out[f] = v;
  }
  return out;
}

function parseChannelConfig(row) {
  let cfg = row.config;
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg); } catch { cfg = {}; }
  }
  return cfg && typeof cfg === 'object' ? cfg : {};
}

async function loadSitesByIds(ids) {
  if (!ids || !ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.query(`SELECT * FROM sites WHERE id IN (${placeholders}) ORDER BY name ASC`, ids);
}

async function loadAllSites() {
  return db.query('SELECT * FROM sites ORDER BY name ASC');
}

async function loadSiteChannelMap(siteIds) {
  if (!siteIds.length) return new Map();
  const placeholders = siteIds.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT sc.site_id, c.name AS channel_name
       FROM site_channels sc JOIN channels c ON c.id = sc.channel_id
      WHERE sc.site_id IN (${placeholders})
      ORDER BY c.name ASC`,
    siteIds
  );
  const map = new Map();
  for (const r of rows) {
    const arr = map.get(Number(r.site_id)) || [];
    arr.push(r.channel_name);
    map.set(Number(r.site_id), arr);
  }
  return map;
}

async function loadAllChannels() {
  const rows = await db.query('SELECT * FROM channels ORDER BY name ASC');
  return rows;
}

async function loadSettingsRow() {
  const rows = await db.query('SELECT * FROM settings WHERE id = 1');
  return rows[0] || null;
}

async function exportConfig({ siteIds, includeChannels, includeSmtp, includeSmtpPassword } = {}) {
  const sites = Array.isArray(siteIds) && siteIds.length ? await loadSitesByIds(siteIds) : await loadAllSites();
  const sitesIdsResolved = sites.map((s) => Number(s.id));
  const channelMap = await loadSiteChannelMap(sitesIdsResolved);

  const monitorsOut = sites.map((s) => ({
    ...normalizeSiteRow(s),
    channels: channelMap.get(Number(s.id)) || [],
  }));

  const usedChannelNames = new Set();
  for (const m of monitorsOut) for (const n of m.channels) usedChannelNames.add(n);

  let channelsOut;
  if (includeChannels) {
    const allChannels = await loadAllChannels();
    channelsOut = allChannels.map((c) => ({
      name: c.name,
      type: c.type,
      enabled: !!c.enabled,
      config: parseChannelConfig(c),
    }));
  } else {
    channelsOut = [];
  }

  let settingsOut;
  if (includeSmtp) {
    const s = await loadSettingsRow();
    if (s) {
      settingsOut = {
        smtp_host: s.smtp_host || null,
        smtp_port: Number(s.smtp_port) || 587,
        smtp_secure: s.smtp_secure ? 1 : 0,
        smtp_user: s.smtp_user || null,
        smtp_from_address: s.smtp_from_address || null,
        smtp_from_name: s.smtp_from_name || 'Uptime',
      };
      if (includeSmtpPassword) settingsOut.smtp_pass = s.smtp_pass || null;
    }
  }

  return {
    version: BACKUP_VERSION,
    app: BACKUP_APP,
    exported_at: new Date().toISOString(),
    counts: {
      monitors: monitorsOut.length,
      channels: channelsOut.length,
      attached_channel_refs: usedChannelNames.size,
      includes_smtp: !!settingsOut,
      includes_smtp_password: !!(settingsOut && Object.prototype.hasOwnProperty.call(settingsOut, 'smtp_pass')),
    },
    monitors: monitorsOut,
    channels: channelsOut,
    settings: settingsOut || null,
  };
}

function validatePayload(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Backup must be a JSON object');
  if (raw.app && raw.app !== BACKUP_APP) throw new Error(`Backup is not from this app (app="${raw.app}")`);
  if (raw.version && Number(raw.version) > BACKUP_VERSION) {
    throw new Error(`Backup format version ${raw.version} is newer than this app supports (${BACKUP_VERSION})`);
  }
  if (!Array.isArray(raw.monitors) && !Array.isArray(raw.channels) && !raw.settings) {
    throw new Error('Backup contains no monitors, channels, or settings');
  }
  if (raw.monitors && !Array.isArray(raw.monitors)) throw new Error('"monitors" must be an array');
  if (raw.channels && !Array.isArray(raw.channels)) throw new Error('"channels" must be an array');
}

function sanitizeImportSite(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('monitor entry is not an object');
  const name = String(raw.name || '').trim();
  if (!name) throw new Error('monitor missing name');

  const monitor_type = VALID_MONITOR_TYPES.includes(raw.monitor_type) ? raw.monitor_type : 'active';
  const method_raw = String(raw.method || 'GET').toUpperCase();
  const method = VALID_METHODS.includes(method_raw) ? method_raw : 'GET';
  const check_type_raw = raw.check_type;
  const check_type = monitor_type === 'active'
    ? (VALID_CHECK_TYPES.includes(check_type_raw) ? check_type_raw : 'status')
    : null;

  let request_headers = raw.request_headers;
  if (typeof request_headers === 'string') {
    try { request_headers = JSON.parse(request_headers); } catch { request_headers = null; }
  }
  if (request_headers && (typeof request_headers !== 'object' || Array.isArray(request_headers))) {
    request_headers = null;
  }

  const channelNames = Array.isArray(raw.channels)
    ? raw.channels.map((s) => String(s || '').trim()).filter(Boolean)
    : [];

  return {
    name,
    url: monitor_type === 'active' ? String(raw.url || '').trim() : '',
    monitor_type,
    method,
    interval_seconds: Math.max(10, parseInt(raw.interval_seconds, 10) || 60),
    timeout_ms: Math.max(1000, parseInt(raw.timeout_ms, 10) || 10000),
    check_type,
    expected_status: monitor_type === 'active' && check_type === 'status'
      ? String(raw.expected_status || '200').trim() : null,
    expected_string: monitor_type === 'active' && check_type === 'string'
      ? (raw.expected_string == null ? '' : String(raw.expected_string)) : null,
    json_path: monitor_type === 'active' && check_type === 'json'
      ? String(raw.json_path || '').trim() : null,
    expected_json_value: monitor_type === 'active' && check_type === 'json'
      ? (raw.expected_json_value == null ? '' : String(raw.expected_json_value)) : null,
    request_headers: monitor_type === 'active' ? request_headers : null,
    failure_threshold: Math.max(1, parseInt(raw.failure_threshold, 10) || 1),
    heartbeat_token: monitor_type === 'heartbeat'
      ? (typeof raw.heartbeat_token === 'string' && /^[a-f0-9]{16,64}$/i.test(raw.heartbeat_token) ? raw.heartbeat_token : null)
      : null,
    heartbeat_grace_seconds: Math.max(5, parseInt(raw.heartbeat_grace_seconds, 10) || 60),
    cloudflare_mode: raw.cloudflare_mode ? 1 : 0,
    paused: raw.paused ? 1 : 0,
    channels: channelNames,
  };
}

function sanitizeImportChannel(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('channel entry is not an object');
  const name = String(raw.name || '').trim();
  if (!name) throw new Error('channel missing name');
  const type = String(raw.type || '').toLowerCase();
  if (!VALID_CHANNEL_TYPES.includes(type)) throw new Error(`channel "${name}" has invalid type "${raw.type}"`);
  let cfg = raw.config;
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg); } catch { cfg = {}; }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  return {
    name,
    type,
    enabled: raw.enabled === false ? 0 : 1,
    config: cfg,
  };
}

async function uniqueSiteName(base) {
  let candidate = base;
  let n = 1;
  while (true) {
    const rows = await db.query('SELECT id FROM sites WHERE name = ? LIMIT 1', [candidate]);
    if (!rows.length) return candidate;
    n += 1;
    candidate = `${base} (${n})`;
    if (n > 999) return `${base} (${crypto.randomBytes(2).toString('hex')})`;
  }
}

async function uniqueChannelName(base) {
  let candidate = base;
  let n = 1;
  while (true) {
    const rows = await db.query('SELECT id FROM channels WHERE name = ? LIMIT 1', [candidate]);
    if (!rows.length) return candidate;
    n += 1;
    candidate = `${base} (${n})`;
    if (n > 999) return `${base} (${crypto.randomBytes(2).toString('hex')})`;
  }
}

async function findChannelByName(name) {
  const rows = await db.query('SELECT id FROM channels WHERE name = ? LIMIT 1', [name]);
  return rows[0] || null;
}

async function findSiteByName(name) {
  const rows = await db.query('SELECT id FROM sites WHERE name = ? LIMIT 1', [name]);
  return rows[0] || null;
}

async function insertSite(data, channelIds) {
  let token = data.heartbeat_token;
  if (data.monitor_type === 'heartbeat') {
    if (token) {
      const conflict = await db.query('SELECT id FROM sites WHERE heartbeat_token = ? LIMIT 1', [token]);
      if (conflict.length) token = crypto.randomBytes(16).toString('hex');
    } else {
      token = crypto.randomBytes(16).toString('hex');
    }
  } else {
    token = null;
  }
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
      data.failure_threshold, token, data.heartbeat_grace_seconds,
      data.cloudflare_mode, data.paused,
    ]
  );
  const id = Number(result.insertId);
  await channels.setSiteChannels(id, channelIds);
  return id;
}

async function updateSiteRow(id, data, channelIds) {
  await db.query(
    `UPDATE sites SET
       url=?, monitor_type=?, method=?, interval_seconds=?, timeout_ms=?,
       check_type=?, expected_status=?, expected_string=?, json_path=?, expected_json_value=?,
       request_headers=?, failure_threshold=?, heartbeat_grace_seconds=?,
       cloudflare_mode=?, paused=?
     WHERE id=?`,
    [
      data.url, data.monitor_type, data.method, data.interval_seconds, data.timeout_ms,
      data.check_type, data.expected_status, data.expected_string, data.json_path, data.expected_json_value,
      data.request_headers ? JSON.stringify(data.request_headers) : null,
      data.failure_threshold, data.heartbeat_grace_seconds,
      data.cloudflare_mode, data.paused, id,
    ]
  );
  if (data.monitor_type === 'heartbeat') {
    const cur = await db.query('SELECT heartbeat_token FROM sites WHERE id = ?', [id]);
    if (!cur[0]?.heartbeat_token) {
      let token = data.heartbeat_token;
      if (token) {
        const conflict = await db.query('SELECT id FROM sites WHERE heartbeat_token = ? AND id <> ? LIMIT 1', [token, id]);
        if (conflict.length) token = crypto.randomBytes(16).toString('hex');
      } else {
        token = crypto.randomBytes(16).toString('hex');
      }
      await db.query('UPDATE sites SET heartbeat_token = ? WHERE id = ?', [token, id]);
    }
  }
  await channels.setSiteChannels(id, channelIds);
  return id;
}

async function importChannels(items, conflict, log) {
  const stats = { created: 0, updated: 0, skipped: 0, renamed: 0, errors: [] };
  const nameToId = new Map();

  for (const raw of items) {
    let item;
    try { item = sanitizeImportChannel(raw); }
    catch (e) {
      stats.errors.push(e.message);
      continue;
    }
    try {
      const existing = await findChannelByName(item.name);
      if (!existing) {
        const id = await channels.createChannel({
          name: item.name, type: item.type, enabled: !!item.enabled, config: item.config,
        });
        nameToId.set(item.name, Number(id));
        stats.created += 1;
      } else if (conflict === 'skip') {
        nameToId.set(item.name, Number(existing.id));
        stats.skipped += 1;
      } else if (conflict === 'replace') {
        await channels.updateChannel(Number(existing.id), {
          name: item.name, type: item.type, enabled: !!item.enabled, config: item.config,
        });
        nameToId.set(item.name, Number(existing.id));
        stats.updated += 1;
      } else if (conflict === 'rename') {
        const newName = await uniqueChannelName(item.name);
        const id = await channels.createChannel({
          name: newName, type: item.type, enabled: !!item.enabled, config: item.config,
        });
        nameToId.set(item.name, Number(id));
        stats.renamed += 1;
      }
    } catch (err) {
      log.error({ err, channel: item?.name }, 'backup.import_channel_failed');
      stats.errors.push(`channel "${item?.name || '?'}": ${err.message}`);
    }
  }

  return { stats, nameToId };
}

async function resolveChannelIds(names, nameToIdFromImport) {
  const out = [];
  const missing = [];
  for (const name of names) {
    let id = nameToIdFromImport.get(name);
    if (!id) {
      const row = await findChannelByName(name);
      if (row) id = Number(row.id);
    }
    if (id) out.push(id); else missing.push(name);
  }
  return { ids: out, missing };
}

async function importMonitors(items, conflict, nameToChannelId, log) {
  const stats = { created: 0, updated: 0, skipped: 0, renamed: 0, errors: [], missingChannels: new Set() };
  const reloadIds = [];

  for (const raw of items) {
    let item;
    try { item = sanitizeImportSite(raw); }
    catch (e) {
      stats.errors.push(e.message);
      continue;
    }

    const { ids: channelIds, missing } = await resolveChannelIds(item.channels, nameToChannelId);
    for (const m of missing) stats.missingChannels.add(m);

    try {
      const existing = await findSiteByName(item.name);
      if (!existing) {
        const id = await insertSite(item, channelIds);
        reloadIds.push(id);
        stats.created += 1;
      } else if (conflict === 'skip') {
        stats.skipped += 1;
      } else if (conflict === 'replace') {
        const id = await updateSiteRow(Number(existing.id), item, channelIds);
        reloadIds.push(id);
        stats.updated += 1;
      } else if (conflict === 'rename') {
        const newName = await uniqueSiteName(item.name);
        const id = await insertSite({ ...item, name: newName }, channelIds);
        reloadIds.push(id);
        stats.renamed += 1;
      }
    } catch (err) {
      log.error({ err, monitor: item?.name }, 'backup.import_monitor_failed');
      stats.errors.push(`monitor "${item?.name || '?'}": ${err.message}`);
    }
  }

  for (const id of reloadIds) {
    try { await monitor.reloadSite(id); }
    catch (err) { log.error({ err, siteId: id }, 'backup.reload_failed'); }
  }

  stats.missingChannels = Array.from(stats.missingChannels);
  return stats;
}

async function importSmtp(payload, log) {
  if (!payload || typeof payload !== 'object') return { applied: false, reason: 'no settings in backup' };
  const fields = ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass',
    'smtp_from_address', 'smtp_from_name'];
  const cur = await loadSettingsRow();
  const out = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(payload, f)) {
      let v = payload[f];
      if (f === 'smtp_secure') v = v ? 1 : 0;
      if (f === 'smtp_port') v = Number(v) || 587;
      out[f] = v;
    } else {
      out[f] = cur ? cur[f] : null;
    }
  }
  if (out.smtp_pass == null && cur) out.smtp_pass = cur.smtp_pass || null;
  await db.query(
    `UPDATE settings SET smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?, smtp_pass=?, smtp_from_address=?, smtp_from_name=? WHERE id=1`,
    [out.smtp_host, out.smtp_port, out.smtp_secure, out.smtp_user, out.smtp_pass, out.smtp_from_address, out.smtp_from_name]
  );
  log.info({ smtp_host: out.smtp_host }, 'backup.smtp_imported');
  return { applied: true };
}

async function importConfig(raw, opts = {}) {
  const log = logger.child({ feature: 'backup.import' });
  validatePayload(raw);

  const conflict = VALID_CONFLICT.includes(opts.conflict) ? opts.conflict : 'skip';
  const importMonitorsFlag = opts.importMonitors !== false;
  const importChannelsFlag = opts.importChannels !== false;
  const importSmtpFlag = !!opts.importSmtp;

  const summary = {
    conflict,
    monitors: { created: 0, updated: 0, skipped: 0, renamed: 0, errors: [], missingChannels: [] },
    channels: { created: 0, updated: 0, skipped: 0, renamed: 0, errors: [] },
    smtp: { applied: false },
  };

  let nameToChannelId = new Map();
  if (importChannelsFlag && Array.isArray(raw.channels) && raw.channels.length) {
    const r = await importChannels(raw.channels, conflict, log);
    summary.channels = r.stats;
    nameToChannelId = r.nameToId;
  }

  if (importMonitorsFlag && Array.isArray(raw.monitors) && raw.monitors.length) {
    summary.monitors = await importMonitors(raw.monitors, conflict, nameToChannelId, log);
  }

  if (importSmtpFlag && raw.settings) {
    try {
      summary.smtp = await importSmtp(raw.settings, log);
    } catch (err) {
      log.error({ err }, 'backup.smtp_failed');
      summary.smtp = { applied: false, error: err.message };
    }
  }

  log.info({ summary }, 'backup.import_complete');
  return summary;
}

module.exports = {
  BACKUP_VERSION,
  BACKUP_APP,
  exportConfig,
  importConfig,
  VALID_CONFLICT,
};
