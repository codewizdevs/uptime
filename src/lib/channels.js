'use strict';

const { request } = require('undici');
const db = require('../db');
const logger = require('../logger');
const config = require('../config');
const tpl = require('./templates');
const email = require('./email');

const CHANNEL_TYPES = [
  'discord', 'webhook', 'email',
  'slack', 'telegram', 'ntfy', 'gotify', 'pushover', 'mattermost', 'teams',
];
const EVENT_TYPES = ['down', 'recovered', 'challenged', 'cert_expiring', 'test'];

// Channel-type metadata used by the UI (icon, badge color, human label).
// Single source of truth — views look this up via channels.CHANNEL_META.
const CHANNEL_META = {
  discord:    { label: 'Discord',         icon: 'ti-brand-discord',    color: 'indigo' },
  webhook:    { label: 'Generic webhook', icon: 'ti-webhook',          color: 'cyan' },
  email:      { label: 'Email',           icon: 'ti-mail',             color: 'blue' },
  slack:      { label: 'Slack',           icon: 'ti-brand-slack',      color: 'lime' },
  telegram:   { label: 'Telegram',        icon: 'ti-brand-telegram',   color: 'azure' },
  ntfy:       { label: 'Ntfy',            icon: 'ti-bell-ringing',     color: 'orange' },
  gotify:     { label: 'Gotify',          icon: 'ti-device-mobile-message', color: 'green' },
  pushover:   { label: 'Pushover',        icon: 'ti-bell-plus',        color: 'red' },
  mattermost: { label: 'Mattermost',      icon: 'ti-message-2',        color: 'purple' },
  teams:      { label: 'MS Teams',        icon: 'ti-brand-teams',      color: 'violet' },
};

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

const CERT_EXPIRING_DEFAULT_DISCORD = ':warning: TLS certificate for {{site_name}} expires in {{cert_days_remaining}} days';
const CERT_EXPIRING_DEFAULT_PLAIN = 'TLS certificate for {{site_name}} expires in {{cert_days_remaining}} days';

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
    cert_expiring: {
      title: CERT_EXPIRING_DEFAULT_DISCORD,
      body: '**URL:** `{{site_url}}`\n**Subject:** `{{cert_subject}}`\n**Issuer:** `{{cert_issuer}}`\n**Expires:** {{cert_valid_to}}',
    },
    test: {
      title: ':white_check_mark: Test message from Uptime',
      body: 'This is a test of the Discord channel. If you see this, your webhook works.',
    },
  },
  webhook: {
    down:          { title: '', body: DEFAULT_WEBHOOK_TEMPLATE },
    recovered:     { title: '', body: DEFAULT_WEBHOOK_TEMPLATE },
    challenged:    { title: '', body: DEFAULT_WEBHOOK_TEMPLATE },
    cert_expiring: { title: '', body: DEFAULT_WEBHOOK_TEMPLATE },
    test:          { title: '', body: DEFAULT_WEBHOOK_TEMPLATE },
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
    cert_expiring: {
      title: '[Cert] {{site_name}} TLS cert expires in {{cert_days_remaining}}d',
      body: 'The TLS certificate for {{site_name}} expires in {{cert_days_remaining}} days.\n\nURL: {{site_url}}\nSubject: {{cert_subject}}\nIssuer: {{cert_issuer}}\nNot after: {{cert_valid_to}}\n\n--\nUptime monitor',
    },
    test: {
      title: '[Test] Uptime monitor email',
      body: 'This is a test email from your Uptime monitor.\nIf you can read this, the email channel works.\n\n--\nUptime monitor',
    },
  },
  slack: {
    down: {
      title: ':red_circle: {{site_name}} is DOWN',
      body: '*URL:* {{site_url}}\n*Reason:* `{{error}}`\n*Type:* {{monitor_type}}',
    },
    recovered: {
      title: ':large_green_circle: {{site_name}} is back UP',
      body: '*URL:* {{site_url}}\n*Downtime:* {{duration_human}}',
    },
    challenged: {
      title: ':shield: {{site_name}} is being Cloudflare-challenged',
      body: '{{streak}} consecutive challenge responses; status is INCONCLUSIVE.\n*URL:* {{site_url}}',
    },
    cert_expiring: {
      title: ':warning: TLS cert for {{site_name}} expires in {{cert_days_remaining}}d',
      body: '*URL:* {{site_url}}\n*Subject:* `{{cert_subject}}`\n*Issuer:* `{{cert_issuer}}`\n*Not after:* {{cert_valid_to}}',
    },
    test: {
      title: ':white_check_mark: Test from Uptime',
      body: 'Slack channel works. This is sample data filled in.',
    },
  },
  telegram: {
    down: {
      title: '🔴 <b>{{site_name}}</b> is DOWN',
      body: 'URL: <code>{{site_url}}</code>\nReason: <code>{{error}}</code>\nType: {{monitor_type}}',
    },
    recovered: {
      title: '🟢 <b>{{site_name}}</b> is back UP',
      body: 'URL: <code>{{site_url}}</code>\nDowntime: {{duration_human}}',
    },
    challenged: {
      title: '🛡 <b>{{site_name}}</b> is being challenged',
      body: '{{streak}} consecutive challenge responses; status is INCONCLUSIVE.\nURL: <code>{{site_url}}</code>',
    },
    cert_expiring: {
      title: '⚠️ <b>{{site_name}}</b> TLS cert expires in {{cert_days_remaining}}d',
      body: 'URL: <code>{{site_url}}</code>\nSubject: <code>{{cert_subject}}</code>\nIssuer: <code>{{cert_issuer}}</code>\nNot after: {{cert_valid_to}}',
    },
    test: {
      title: '✅ Test from Uptime',
      body: 'Telegram channel works. This is sample data filled in.',
    },
  },
  ntfy: {
    down: {
      title: '🔴 {{site_name}} is DOWN',
      body: '{{site_url}}\n{{error}}',
    },
    recovered: {
      title: '🟢 {{site_name}} is back UP',
      body: '{{site_url}}\nDowntime: {{duration_human}}',
    },
    challenged: {
      title: '🛡 {{site_name}} challenged',
      body: '{{streak}} consecutive Cloudflare challenges. INCONCLUSIVE.\n{{site_url}}',
    },
    cert_expiring: {
      title: '⚠️ {{site_name}} TLS cert expires in {{cert_days_remaining}}d',
      body: '{{site_url}}\nIssuer: {{cert_issuer}}\nNot after: {{cert_valid_to}}',
    },
    test: {
      title: '✅ Test from Uptime',
      body: 'Ntfy channel works.',
    },
  },
  gotify: {
    down: {
      title: '🔴 {{site_name}} is DOWN',
      body: 'URL: {{site_url}}\nReason: {{error}}',
    },
    recovered: {
      title: '🟢 {{site_name}} is back UP',
      body: 'URL: {{site_url}}\nDowntime: {{duration_human}}',
    },
    challenged: {
      title: '🛡 {{site_name}} challenged',
      body: '{{streak}} consecutive Cloudflare challenges.\nURL: {{site_url}}',
    },
    cert_expiring: {
      title: '⚠️ {{site_name}} TLS cert expires in {{cert_days_remaining}}d',
      body: 'URL: {{site_url}}\nIssuer: {{cert_issuer}}\nNot after: {{cert_valid_to}}',
    },
    test: {
      title: '✅ Test from Uptime',
      body: 'Gotify channel works.',
    },
  },
  pushover: {
    down: {
      title: 'DOWN: {{site_name}}',
      body: '{{site_url}}\nReason: {{error}}',
    },
    recovered: {
      title: 'UP: {{site_name}}',
      body: '{{site_url}}\nDowntime: {{duration_human}}',
    },
    challenged: {
      title: 'CHALLENGED: {{site_name}}',
      body: '{{streak}} consecutive Cloudflare challenges.\n{{site_url}}',
    },
    cert_expiring: {
      title: 'CERT: {{site_name}} ({{cert_days_remaining}}d left)',
      body: '{{site_url}}\nIssuer: {{cert_issuer}}\nNot after: {{cert_valid_to}}',
    },
    test: {
      title: 'Test from Uptime',
      body: 'Pushover channel works.',
    },
  },
  mattermost: {
    down: {
      title: ':red_circle: {{site_name}} is DOWN',
      body: '**URL:** {{site_url}}\n**Reason:** `{{error}}`\n**Type:** {{monitor_type}}',
    },
    recovered: {
      title: ':large_green_circle: {{site_name}} is back UP',
      body: '**URL:** {{site_url}}\n**Downtime:** {{duration_human}}',
    },
    challenged: {
      title: ':shield: {{site_name}} challenged',
      body: '{{streak}} consecutive challenge responses; status is INCONCLUSIVE.\n**URL:** {{site_url}}',
    },
    cert_expiring: {
      title: ':warning: TLS cert for {{site_name}} expires in {{cert_days_remaining}}d',
      body: '**URL:** {{site_url}}\n**Subject:** `{{cert_subject}}`\n**Issuer:** `{{cert_issuer}}`\n**Not after:** {{cert_valid_to}}',
    },
    test: {
      title: ':white_check_mark: Test from Uptime',
      body: 'Mattermost channel works.',
    },
  },
  teams: {
    down: {
      title: '🔴 {{site_name}} is DOWN',
      body: '**URL:** {{site_url}}  \n**Reason:** `{{error}}`  \n**Type:** {{monitor_type}}',
    },
    recovered: {
      title: '🟢 {{site_name}} is back UP',
      body: '**URL:** {{site_url}}  \n**Downtime:** {{duration_human}}',
    },
    challenged: {
      title: '🛡 {{site_name}} challenged',
      body: '{{streak}} consecutive Cloudflare challenges; status is INCONCLUSIVE.  \n**URL:** {{site_url}}',
    },
    cert_expiring: {
      title: '⚠️ {{site_name}} TLS cert expires in {{cert_days_remaining}}d',
      body: '**URL:** {{site_url}}  \n**Subject:** `{{cert_subject}}`  \n**Issuer:** `{{cert_issuer}}`  \n**Not after:** {{cert_valid_to}}',
    },
    test: {
      title: '✅ Test from Uptime',
      body: 'MS Teams channel works.',
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
  if (type === 'slack') {
    return {
      webhook_url: String(cfg.webhook_url || '').trim(),
      templates,
    };
  }
  if (type === 'telegram') {
    return {
      bot_token: String(cfg.bot_token || '').trim(),
      chat_id: String(cfg.chat_id || '').trim(),
      message_thread_id: cfg.message_thread_id ? String(cfg.message_thread_id).trim() : '',
      disable_preview: cfg.disable_preview ? 1 : 0,
      templates,
    };
  }
  if (type === 'ntfy') {
    const tags = Array.isArray(cfg.tags)
      ? cfg.tags
      : String(cfg.tags || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const priority = parseInt(cfg.priority, 10);
    return {
      topic_url: String(cfg.topic_url || '').trim(),
      auth_token: String(cfg.auth_token || '').trim(),
      priority: Number.isFinite(priority) && priority >= 1 && priority <= 5 ? priority : 3,
      tags,
      click_url: String(cfg.click_url || '').trim(),
      templates,
    };
  }
  if (type === 'gotify') {
    const priority = parseInt(cfg.priority, 10);
    return {
      server_url: String(cfg.server_url || '').trim().replace(/\/+$/, ''),
      app_token: String(cfg.app_token || '').trim(),
      priority: Number.isFinite(priority) ? Math.max(0, Math.min(10, priority)) : 5,
      templates,
    };
  }
  if (type === 'pushover') {
    const priority = parseInt(cfg.priority, 10);
    return {
      app_token: String(cfg.app_token || '').trim(),
      user_key: String(cfg.user_key || '').trim(),
      device: String(cfg.device || '').trim(),
      priority: Number.isFinite(priority) && priority >= -2 && priority <= 2 ? priority : 0,
      sound: String(cfg.sound || '').trim(),
      templates,
    };
  }
  if (type === 'mattermost') {
    return {
      webhook_url: String(cfg.webhook_url || '').trim(),
      templates,
    };
  }
  if (type === 'teams') {
    return {
      webhook_url: String(cfg.webhook_url || '').trim(),
      templates,
    };
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

const COLORS = { down: 0xd6336c, recovered: 0x2fb344, challenged: 0xf59f00, cert_expiring: 0xf59f00, test: 0x4263eb };
// Hex strings for channels that want "#ff0000" form.
const COLORS_HEX = {
  down: '#d6336c', recovered: '#2fb344', challenged: '#f59f00',
  cert_expiring: '#f59f00', test: '#4263eb',
};
// Ntfy tag suggestions per event (renders as emoji on the receiver).
const NTFY_DEFAULT_TAGS = {
  down: ['rotating_light', 'warning'],
  recovered: ['white_check_mark', 'green_circle'],
  challenged: ['shield', 'cloud'],
  cert_expiring: ['warning', 'lock'],
  test: ['white_check_mark'],
};
// Pushover priority mapping: -2..2 (silent..emergency). We respect channel
// config but fall back to a sensible per-event default.
const PUSHOVER_DEFAULT_PRIORITY = { down: 1, recovered: 0, challenged: 0, cert_expiring: 0, test: 0 };

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

  if (channel.type === 'slack' || channel.type === 'mattermost') {
    if (!cfg.webhook_url) { log.warn({ channelId: channel.id }, 'dispatch.slack_no_url'); return; }
    const title = tpl.render(pickTemplate(channel, event, 'title'), vars);
    const text  = tpl.render(pickTemplate(channel, event, 'body'),  vars);
    const payload = {
      attachments: [{
        color: COLORS_HEX[event] || COLORS_HEX.test,
        title: title || undefined,
        text: text || undefined,
        title_link: vars.site_url || undefined,
        footer: 'Uptime monitor',
        ts: Math.floor(Date.now() / 1000),
      }],
    };
    if (config.appDebug) {
      log.info({ channelId: channel.id, channelName: channel.name, event, payload }, `[${channel.type}:dry-run] APP_DEBUG=true`);
      return;
    }
    try {
      const res = await request(cfg.webhook_url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      res.body.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) log.info({ channelId: channel.id, event, status: res.statusCode }, `dispatch.${channel.type}.delivered`);
      else log.warn({ channelId: channel.id, event, status: res.statusCode }, `dispatch.${channel.type}.bad_response`);
    } catch (err) {
      log.error({ err, channelId: channel.id }, `dispatch.${channel.type}.failed`);
    }
    return;
  }

  if (channel.type === 'telegram') {
    if (!cfg.bot_token || !cfg.chat_id) { log.warn({ channelId: channel.id }, 'dispatch.telegram_missing_config'); return; }
    const title = tpl.render(pickTemplate(channel, event, 'title'), vars);
    const body  = tpl.render(pickTemplate(channel, event, 'body'),  vars);
    const text = (title && body) ? `${title}\n\n${body}` : (title || body || '');
    const payload = {
      chat_id: cfg.chat_id,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: !!cfg.disable_preview,
    };
    if (cfg.message_thread_id) payload.message_thread_id = parseInt(cfg.message_thread_id, 10);
    const url = `https://api.telegram.org/bot${encodeURIComponent(cfg.bot_token)}/sendMessage`;
    if (config.appDebug) {
      log.info({ channelId: channel.id, channelName: channel.name, event, urlMasked: url.replace(cfg.bot_token, '[redacted]'), payload }, '[telegram:dry-run] APP_DEBUG=true');
      return;
    }
    try {
      const res = await request(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const respBody = await res.body.text();
      if (res.statusCode >= 200 && res.statusCode < 300) log.info({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.telegram.delivered');
      else log.warn({ channelId: channel.id, event, status: res.statusCode, body: respBody.slice(0, 200) }, 'dispatch.telegram.bad_response');
    } catch (err) {
      log.error({ err, channelId: channel.id }, 'dispatch.telegram.failed');
    }
    return;
  }

  if (channel.type === 'ntfy') {
    if (!cfg.topic_url) { log.warn({ channelId: channel.id }, 'dispatch.ntfy_no_url'); return; }
    const title = tpl.render(pickTemplate(channel, event, 'title'), vars);
    const body  = tpl.render(pickTemplate(channel, event, 'body'),  vars);
    const tags = (cfg.tags && cfg.tags.length) ? cfg.tags : NTFY_DEFAULT_TAGS[event] || [];
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Title': title || undefined,
      'Priority': String(cfg.priority || 3),
      'Tags': tags.length ? tags.join(',') : undefined,
      'Click': cfg.click_url || vars.site_url || undefined,
    };
    if (cfg.auth_token) headers['Authorization'] = `Bearer ${cfg.auth_token}`;
    if (config.appDebug) {
      log.info({ channelId: channel.id, channelName: channel.name, event, url: cfg.topic_url, headers: { ...headers, Authorization: cfg.auth_token ? '[redacted]' : undefined }, body }, '[ntfy:dry-run] APP_DEBUG=true');
      return;
    }
    try {
      // Strip undefined header values so undici doesn't choke.
      for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
      const res = await request(cfg.topic_url, { method: 'POST', headers, body });
      res.body.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) log.info({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.ntfy.delivered');
      else log.warn({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.ntfy.bad_response');
    } catch (err) {
      log.error({ err, channelId: channel.id }, 'dispatch.ntfy.failed');
    }
    return;
  }

  if (channel.type === 'gotify') {
    if (!cfg.server_url || !cfg.app_token) { log.warn({ channelId: channel.id }, 'dispatch.gotify_missing_config'); return; }
    const title = tpl.render(pickTemplate(channel, event, 'title'), vars);
    const body  = tpl.render(pickTemplate(channel, event, 'body'),  vars);
    const payload = {
      title: title || undefined,
      message: body || ' ',
      priority: cfg.priority != null ? cfg.priority : 5,
      extras: { 'client::notification': { click: { url: vars.site_url || undefined } } },
    };
    const url = `${cfg.server_url}/message?token=${encodeURIComponent(cfg.app_token)}`;
    if (config.appDebug) {
      log.info({ channelId: channel.id, channelName: channel.name, event, url: url.replace(cfg.app_token, '[redacted]'), payload }, '[gotify:dry-run] APP_DEBUG=true');
      return;
    }
    try {
      const res = await request(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      res.body.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) log.info({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.gotify.delivered');
      else log.warn({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.gotify.bad_response');
    } catch (err) {
      log.error({ err, channelId: channel.id }, 'dispatch.gotify.failed');
    }
    return;
  }

  if (channel.type === 'pushover') {
    if (!cfg.app_token || !cfg.user_key) { log.warn({ channelId: channel.id }, 'dispatch.pushover_missing_config'); return; }
    const title = tpl.render(pickTemplate(channel, event, 'title'), vars);
    const body  = tpl.render(pickTemplate(channel, event, 'body'),  vars);
    const priority = cfg.priority != null ? cfg.priority : (PUSHOVER_DEFAULT_PRIORITY[event] ?? 0);
    const payload = {
      token: cfg.app_token,
      user: cfg.user_key,
      title: title || undefined,
      message: body || ' ',
      priority,
      url: vars.site_url || undefined,
      url_title: vars.site_name || undefined,
    };
    if (cfg.device) payload.device = cfg.device;
    if (cfg.sound) payload.sound = cfg.sound;
    // Emergency priority requires retry/expire — set sane defaults.
    if (priority === 2) { payload.retry = 60; payload.expire = 3600; }
    if (config.appDebug) {
      log.info({ channelId: channel.id, channelName: channel.name, event, payload: { ...payload, token: '[redacted]', user: '[redacted]' } }, '[pushover:dry-run] APP_DEBUG=true');
      return;
    }
    try {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(payload)) if (v !== undefined && v !== null) form.append(k, String(v));
      const res = await request('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      res.body.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) log.info({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.pushover.delivered');
      else log.warn({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.pushover.bad_response');
    } catch (err) {
      log.error({ err, channelId: channel.id }, 'dispatch.pushover.failed');
    }
    return;
  }

  if (channel.type === 'teams') {
    if (!cfg.webhook_url) { log.warn({ channelId: channel.id }, 'dispatch.teams_no_url'); return; }
    const title = tpl.render(pickTemplate(channel, event, 'title'), vars);
    const body  = tpl.render(pickTemplate(channel, event, 'body'),  vars);
    // Legacy MessageCard format — broadly compatible with both classic Teams
    // incoming webhooks and the new Workflow webhook posting connector.
    const payload = {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      summary: title || (vars.site_name + ' status update'),
      themeColor: (COLORS_HEX[event] || COLORS_HEX.test).replace('#', ''),
      title: title || undefined,
      text: body || undefined,
      potentialAction: vars.site_url ? [{
        '@type': 'OpenUri',
        name: 'Open monitor URL',
        targets: [{ os: 'default', uri: vars.site_url }],
      }] : undefined,
    };
    if (config.appDebug) {
      log.info({ channelId: channel.id, channelName: channel.name, event, payload }, '[teams:dry-run] APP_DEBUG=true');
      return;
    }
    try {
      const res = await request(cfg.webhook_url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      res.body.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) log.info({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.teams.delivered');
      else log.warn({ channelId: channel.id, event, status: res.statusCode }, 'dispatch.teams.bad_response');
    } catch (err) {
      log.error({ err, channelId: channel.id }, 'dispatch.teams.failed');
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
  { key: 'event', desc: 'down | recovered | challenged | cert_expiring | test' },
  { key: 'state', desc: 'down | up | challenged | test' },
  { key: 'site_name', desc: 'Monitor name' },
  { key: 'site_url', desc: 'Monitored URL (active monitors)' },
  { key: 'monitor_type', desc: 'active | heartbeat | cert | tcp | ping | dns' },
  { key: 'error', desc: 'Failure reason / error message' },
  { key: 'status_code', desc: 'HTTP status of the failed/succeeded check' },
  { key: 'response_time_ms', desc: 'Response time in milliseconds' },
  { key: 'duration_seconds', desc: 'Downtime duration in seconds (recovered)' },
  { key: 'duration_human', desc: 'Downtime in "1h 23m 4s" form (recovered)' },
  { key: 'streak', desc: 'Consecutive challenge count (challenged event)' },
  { key: 'cert_days_remaining', desc: 'Days until the TLS cert expires (cert_expiring)' },
  { key: 'cert_subject', desc: 'TLS cert subject CN (cert_expiring)' },
  { key: 'cert_issuer', desc: 'TLS cert issuer CN (cert_expiring)' },
  { key: 'cert_valid_to', desc: 'TLS cert expiry timestamp (cert_expiring)' },
  { key: 'timestamp', desc: 'ISO 8601 timestamp' },
  { key: 'timestamp_human', desc: 'Human-readable local time' },
];

module.exports = {
  CHANNEL_TYPES,
  CHANNEL_META,
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
