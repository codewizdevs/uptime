'use strict';

const { request } = require('undici');
const db = require('../db');
const logger = require('../logger');
const config = require('../config');
const tpl = require('./templates');
const email = require('./email');

const CHANNEL_TYPES = ['discord', 'webhook', 'email'];
const EVENT_TYPES = ['down', 'recovered', 'challenged', 'test'];

const DEFAULT_WEBHOOK_TEMPLATE = `{
  "event": "{{event}}",
  "site": "{{site_name}}",
  "url": "{{site_url}}",
  "state": "{{state}}",
  "error": "{{error}}",
  "status_code": "{{status_code}}",
  "response_time_ms": "{{response_time_ms}}",
  "duration_seconds": "{{duration_seconds}}",
  "duration_human": "{{duration_human}}",
  "timestamp": "{{timestamp}}"
}`;

const DEFAULT_TEMPLATES = {
  discord: {
    down: {
      title: ':red_circle: {{site_name}} is DOWN',
      body: '**URL:** `{{site_url}}`\n**Reason:** `{{error}}`\n**Type:** {{monitor_type}}',
    },
    recovered: {
      title: ':green_circle: {{site_name}} is back UP',
      body: '**URL:** `{{site_url}}`\n**Downtime:** `{{duration_human}}`',
    },
    challenged: {
      title: ':shield: {{site_name}} is being Cloudflare-challenged',
      body: '{{streak}} consecutive challenge responses; status is INCONCLUSIVE. Adaptive backoff active.\n**URL:** `{{site_url}}`',
    },
    test: {
      title: ':white_check_mark: Test message from Uptime',
      body: 'This is a test of the Discord channel. If you see this, your webhook works.',
    },
  },
  webhook: {
    down:       { title: '', body: DEFAULT_WEBHOOK_TEMPLATE },
    recovered:  { title: '', body: DEFAULT_WEBHOOK_TEMPLATE },
    challenged: { title: '', body: DEFAULT_WEBHOOK_TEMPLATE },
    test:       { title: '', body: DEFAULT_WEBHOOK_TEMPLATE },
  },
  email: {
    down: {
      title: '[DOWN] {{site_name}}',
      body: '{{site_name}} is DOWN.\n\nURL: {{site_url}}\nReason: {{error}}\nType: {{monitor_type}}\nTime: {{timestamp_human}}\n\n--\nUptime monitor',
    },
    recovered: {
      title: '[UP] {{site_name}} recovered',
      body: '{{site_name}} is back UP.\n\nURL: {{site_url}}\nDowntime: {{duration_human}}\nTime: {{timestamp_human}}\n\n--\nUptime monitor',
    },
    challenged: {
      title: '[Cloudflare] {{site_name}} is being challenged',
      body: '{{site_name}} is being Cloudflare-challenged.\n\n{{streak}} consecutive challenge responses; status is INCONCLUSIVE.\nURL: {{site_url}}\nTime: {{timestamp_human}}\n\n--\nUptime monitor',
    },
    test: {
      title: '[Test] Uptime monitor email',
      body: 'This is a test email from your Uptime monitor.\nIf you can read this, the email channel works.\n\n--\nUptime monitor',
    },
  },
};

function emptyTemplates() {
  const out = {};
  for (const ev of EVENT_TYPES) out[ev] = { title: '', body: '' };
  return out;
}

function sanitizeTemplates(raw) {
  const out = emptyTemplates();
  if (!raw || typeof raw !== 'object') return out;
  for (const ev of EVENT_TYPES) {
    const v = raw[ev];
    if (v && typeof v === 'object') {
      out[ev] = {
        title: typeof v.title === 'string' ? v.title : '',
        body: typeof v.body === 'string' ? v.body : '',
      };
    }
  }
  return out;
}

function pickTemplate(channel, event, field) {
  const ev = EVENT_TYPES.includes(event) ? event : 'test';
  const userVal = channel?.config?.templates?.[ev]?.[field];
  if (userVal && String(userVal).trim() !== '') return userVal;
  return DEFAULT_TEMPLATES[channel.type]?.[ev]?.[field] || '';
}

function sanitizeConfig(type, raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const templates = sanitizeTemplates(cfg.templates);

  if (type === 'discord') {
    return {
      webhook_url: String(cfg.webhook_url || '').trim(),
      templates,
    };
  }
  if (type === 'webhook') {
    let legacyTemplate = typeof cfg.body_template === 'string' ? cfg.body_template.trim() : '';
    if (legacyTemplate) {
      for (const ev of EVENT_TYPES) {
        if (!templates[ev].body) templates[ev].body = legacyTemplate;
      }
    }
    return {
      url: String(cfg.url || '').trim(),
      method: ['POST', 'PUT', 'PATCH'].includes(String(cfg.method || '').toUpperCase()) ? cfg.method.toUpperCase() : 'POST',
      content_type: String(cfg.content_type || 'application/json').trim() || 'application/json',
      headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
      templates,
    };
  }
  if (type === 'email') {
    const arr = Array.isArray(cfg.to) ? cfg.to : String(cfg.to || '').split(/[\s,;]+/);
    const to = arr.map((s) => String(s).trim()).filter(Boolean);
    return { to, templates };
  }
  return cfg;
}

function parseConfig(row) {
  if (!row) return null;
  let cfg = row.config;
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg); } catch { cfg = {}; }
  }
  cfg = cfg || {};
  if (!cfg.templates) cfg.templates = emptyTemplates();
  if (row.type === 'webhook' && cfg.body_template) {
    for (const ev of EVENT_TYPES) {
      if (!cfg.templates[ev] || !cfg.templates[ev].body) {
        cfg.templates[ev] = { ...(cfg.templates[ev] || { title: '' }), body: cfg.body_template };
      }
    }
  }
  return { ...row, config: cfg };
}

async function listChannels() {
  const rows = await db.query('SELECT * FROM channels ORDER BY name ASC');
  return rows.map(parseConfig);
}

async function getChannel(id) {
  const rows = await db.query('SELECT * FROM channels WHERE id = ?', [id]);
  return parseConfig(rows[0] || null);
}

async function createChannel({ name, type, enabled, config }) {
  if (!CHANNEL_TYPES.includes(type)) throw new Error('Invalid channel type');
  const cfg = sanitizeConfig(type, config);
  const result = await db.query(
    `INSERT INTO channels (name, type, enabled, config) VALUES (?, ?, ?, ${db.castJson()})`,
    [name, type, enabled ? 1 : 0, JSON.stringify(cfg)]
  );
  logger.info({ channelId: result.insertId, type, name }, 'channels.created');
  return result.insertId;
}

async function updateChannel(id, { name, enabled, config, type }) {
  const cur = await getChannel(id);
  if (!cur) throw new Error('Channel not found');
  const useType = type || cur.type;
  const cfg = sanitizeConfig(useType, config);
  await db.query(
    `UPDATE channels SET name = ?, enabled = ?, config = ${db.castJson()} WHERE id = ?`,
    [name, enabled ? 1 : 0, JSON.stringify(cfg), id]
  );
  logger.info({ channelId: id, name }, 'channels.updated');
}

async function deleteChannel(id) {
  await db.query('DELETE FROM channels WHERE id = ?', [id]);
  logger.info({ channelId: id }, 'channels.deleted');
}

async function loadSiteChannels(siteId) {
  const rows = await db.query(
    `SELECT c.*
       FROM channels c
       JOIN site_channels sc ON sc.channel_id = c.id
      WHERE sc.site_id = ? AND c.enabled = 1
      ORDER BY c.name ASC`,
    [siteId]
  );
  return rows.map(parseConfig);
}

async function listSiteChannelIds(siteId) {
  const rows = await db.query(`SELECT channel_id FROM site_channels WHERE site_id = ?`, [siteId]);
  return rows.map((r) => Number(r.channel_id));
}

async function setSiteChannels(siteId, channelIds) {
  await db.query('DELETE FROM site_channels WHERE site_id = ?', [siteId]);
  const ids = Array.from(new Set((channelIds || []).map(Number).filter(Boolean)));
  if (!ids.length) return;
  const values = ids.map(() => '(?, ?)').join(', ');
  const params = ids.flatMap((cid) => [siteId, cid]);
  await db.query(`INSERT INTO site_channels (site_id, channel_id) VALUES ${values}`, params);
}

const COLORS = { down: 0xd6336c, recovered: 0x2fb344, challenged: 0xf59f00, test: 0x4263eb };

function buildDiscordPayload(event, vars, channel) {
  const titleTpl = pickTemplate(channel, event, 'title');
  const bodyTpl = pickTemplate(channel, event, 'body');
  const title = tpl.render(titleTpl, vars);
  const description = tpl.render(bodyTpl, vars);
  return {
    embeds: [{
      title: title || undefined,
      url: vars.site_url || undefined,
      color: COLORS[event] || COLORS.test,
      description: description || undefined,
      timestamp: vars.timestamp,
      footer: { text: 'Uptime monitor' },
    }],
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function bodyToHtml(body) {
  return escapeHtml(body)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

function buildEmailPayload(event, vars, channel) {
  const subjectTpl = pickTemplate(channel, event, 'title');
  const bodyTpl = pickTemplate(channel, event, 'body');
  const subject = tpl.render(subjectTpl, vars) || `[Uptime] ${vars.site_name}`;
  const text = tpl.render(bodyTpl, vars);
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;font-size:14px;">
      ${bodyToHtml(text)}
    </div>`;
  return { subject, text, html };
}

function buildWebhookBody(event, vars, channel) {
  const bodyTpl = pickTemplate(channel, event, 'body') || DEFAULT_WEBHOOK_TEMPLATE;
  return tpl.render(bodyTpl, vars);
}

async function dispatchToChannel(channel, event, vars, log) {
  const cfg = channel.config || {};
  if (!channel.enabled) {
    log.debug({ channelId: channel.id }, 'dispatch.skip_disabled');
    return;
  }

  if (channel.type === 'discord') {
    if (!cfg.webhook_url) { log.warn({ channelId: channel.id }, 'dispatch.discord_no_url'); return; }
    const payload = buildDiscordPayload(event, vars, channel);
    if (config.appDebug) {
      log.info({ channelId: channel.id, channelName: channel.name, event, payload, webhookUrl: cfg.webhook_url }, '[discord:dry-run] APP_DEBUG=true, webhook NOT sent');
      return;
    }
    try {
      const res = await request(cfg.webhook_url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      res.body.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) log.info({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.discord.delivered');
      else log.warn({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.discord.bad_response');
    } catch (err) {
      log.error({ err, channelId: channel.id }, 'dispatch.discord.failed');
    }
    return;
  }

  if (channel.type === 'webhook') {
    if (!cfg.url) { log.warn({ channelId: channel.id }, 'dispatch.webhook_no_url'); return; }
    const bodyText = buildWebhookBody(event, vars, channel);
    let jsonValid = true;
    try { JSON.parse(bodyText); } catch { jsonValid = false; }
    const headers = { 'Content-Type': cfg.content_type || 'application/json', ...(cfg.headers || {}) };
    if (config.appDebug) {
      log.info({ channelId: channel.id, channelName: channel.name, event, url: cfg.url, method: cfg.method, headers, body: bodyText, jsonValid }, '[webhook:dry-run] APP_DEBUG=true, request NOT sent');
      return;
    }
    try {
      const res = await request(cfg.url, { method: cfg.method || 'POST', headers, body: bodyText });
      res.body.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) log.info({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.webhook.delivered');
      else log.warn({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.webhook.bad_response');
    } catch (err) {
      log.error({ err, channelId: channel.id }, 'dispatch.webhook.failed');
    }
    return;
  }

  if (channel.type === 'email') {
    const recipients = (cfg.to || []).filter(Boolean);
    if (!recipients.length) { log.warn({ channelId: channel.id }, 'dispatch.email_no_recipients'); return; }
    const built = buildEmailPayload(event, vars, channel);
    try {
      await email.sendMail({ to: recipients, subject: built.subject, text: built.text, html: built.html });
      log.info({ channelId: channel.id, event, recipients }, 'dispatch.email.delivered_or_dryrun');
    } catch (err) {
      log.error({ err, channelId: channel.id }, 'dispatch.email.failed');
    }
    return;
  }

  log.warn({ channelId: channel.id, type: channel.type }, 'dispatch.unknown_type');
}

async function notifySite(site, event, payload = {}) {
  const log = logger.child({ siteId: site.id, siteName: site.name, event });
  const channels = await loadSiteChannels(site.id);
  if (!channels.length) {
    log.debug('dispatch.no_channels');
    return;
  }
  const vars = tpl.buildVars(event, site, payload);
  await Promise.all(channels.map((c) => dispatchToChannel(c, event, vars, log)));
}

async function testChannel(channelId) {
  const channel = await getChannel(channelId);
  if (!channel) throw new Error('Channel not found');
  const vars = tpl.sampleVars();
  const log = logger.child({ channelId, type: channel.type });
  await dispatchToChannel(channel, 'test', vars, log);
}

const PLACEHOLDERS = [
  { key: 'event', desc: 'down | recovered | challenged | test' },
  { key: 'state', desc: 'down | up | challenged | test' },
  { key: 'site_name', desc: 'Monitor name' },
  { key: 'site_url', desc: 'Monitored URL (active monitors)' },
  { key: 'monitor_type', desc: 'active | heartbeat' },
  { key: 'error', desc: 'Failure reason / error message' },
  { key: 'status_code', desc: 'HTTP status of the failed/succeeded check' },
  { key: 'response_time_ms', desc: 'Response time in milliseconds' },
  { key: 'duration_seconds', desc: 'Downtime duration in seconds (recovered)' },
  { key: 'duration_human', desc: 'Downtime in "1h 23m 4s" form (recovered)' },
  { key: 'streak', desc: 'Consecutive challenge count (challenged event)' },
  { key: 'timestamp', desc: 'ISO 8601 timestamp' },
  { key: 'timestamp_human', desc: 'Human-readable local time' },
];

module.exports = {
  CHANNEL_TYPES,
  EVENT_TYPES,
  DEFAULT_WEBHOOK_TEMPLATE,
  DEFAULT_TEMPLATES,
  PLACEHOLDERS,
  emptyTemplates,
  pickTemplate,
  listChannels, getChannel, createChannel, updateChannel, deleteChannel,
  loadSiteChannels, listSiteChannelIds, setSiteChannels,
  notifySite, testChannel,
};
