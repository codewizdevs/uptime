'use strict';

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const email = require('../lib/email');
const maintenance = require('../lib/maintenance');
const apiTokens = require('../lib/apiTokens');
const brandingLib = require('../lib/branding');
const QRCode = require('qrcode');
const {
  authenticator,
  getTotpState,
  saveTotpState,
  generateRecoveryCodes,
  hashRecovery,
} = require('../auth');
const audit = require('../lib/audit');
const logger = require('../logger');
const config = require('../config');
const { parseId } = require('../lib/ids');
const acl = require('../lib/acl');
const users = require('../lib/users');
const grants = require('../lib/grants');
const {
  getUserTotpState,
  saveUserTotpState,
} = require('../auth');

const router = express.Router();

// Paths inside /settings that any logged-in user can hit. Everything else
// under /settings is admin-only (enforced below).
// - /settings/account/*  → own password + own 2FA + own API tokens
// - /settings/audit      → admins see all, editors/viewers see only their own
const NON_ADMIN_SETTINGS_PATHS = [
  /^\/settings\/account(\/|$)/,
  /^\/settings\/audit(\/|$)/,
];

router.use('/settings', (req, res, next) => {
  if (NON_ADMIN_SETTINGS_PATHS.some((re) => re.test(req.path))) return next();
  return acl.requireRole('admin')(req, res, next);
});

const brandingUploadRaw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: brandingLib.MAX_BYTES, files: 2 },
}).fields([
  { name: 'logo_file', maxCount: 1 },
  { name: 'favicon_file', maxCount: 1 },
]);

// Surface multer errors (oversize, too many files, bad multipart) as flash
// messages on the same page instead of a 500. Anything else bubbles up.
function brandingUpload(req, res, next) {
  brandingUploadRaw(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Uploaded file exceeds ' + Math.round(brandingLib.MAX_BYTES / 1024) + ' KB limit'
        : 'Upload rejected: ' + err.message;
      req.flash('error', msg);
      return res.redirect('/settings/branding');
    }
    next(err);
  });
}

router.get('/settings/smtp', async (req, res, next) => {
  try {
    const s = (await email.getSettings()) || {};
    res.render('settings-smtp', {
      title: 'Email settings (SMTP)',
      settings: s,
      isConfigured: email.isConfigured(s),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/smtp', async (req, res, next) => {
  try {
    const b = req.body || {};
    const payload = {
      smtp_host: (b.smtp_host || '').trim() || null,
      smtp_port: parseInt(b.smtp_port, 10) || 587,
      smtp_secure: b.smtp_secure === '1' || b.smtp_secure === 'on' ? 1 : 0,
      smtp_user: (b.smtp_user || '').trim() || null,
      smtp_pass: (b.smtp_pass != null && b.smtp_pass !== '') ? b.smtp_pass : null,
      smtp_from_address: (b.smtp_from_address || '').trim() || null,
      smtp_from_name: (b.smtp_from_name || 'Uptime').trim() || 'Uptime',
    };
    if (payload.smtp_pass == null) {
      const cur = await email.getSettings();
      payload.smtp_pass = cur?.smtp_pass || null;
    }
    await email.updateSettings(payload);
    req.flash('success', 'SMTP settings saved');
    res.redirect('/settings/smtp');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/smtp/test', async (req, res, next) => {
  try {
    const to = (req.body.to || '').trim();
    if (!to) {
      req.flash('error', 'Please provide a "to" address for the test email');
      return res.redirect('/settings/smtp');
    }
    await email.sendMail({
      to,
      subject: '[Test] Uptime email',
      text: 'This is a test email from your Uptime monitor. If you can read this, SMTP is configured correctly.',
      html: '<p>This is a test email from your Uptime monitor.</p><p>If you can read this, SMTP is configured correctly.</p>',
    });
    req.flash('success', `Test email sent to ${to} (or logged in dry-run if APP_DEBUG=true)`);
    res.redirect('/settings/smtp');
  } catch (err) {
    logger.error({ err }, 'settings.smtp_test_failed');
    req.flash('error', 'Test email failed: ' + err.message);
    res.redirect('/settings/smtp');
  }
});

router.post('/settings/smtp/verify', async (req, res, next) => {
  try {
    await email.verifyConnection();
    req.flash('success', 'SMTP connection verified');
    res.redirect('/settings/smtp');
  } catch (err) {
    req.flash('error', 'SMTP verify failed: ' + err.message);
    res.redirect('/settings/smtp');
  }
});

// ─── Public status page settings ─────────────────────────────────────────

// ─── Branding / whitelabel ────────────────────────────────────────────────
router.get('/settings/branding', async (req, res, next) => {
  try {
    const current = await brandingLib.get();
    const defaults = brandingLib.defaults();
    res.render('settings-branding', {
      title: 'Branding & whitelabel',
      current,
      defaults,
      maxBytes: brandingLib.MAX_BYTES,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/branding', brandingUpload, async (req, res, next) => {
  try {
    const b = req.body || {};
    await brandingLib.update({
      appName: b.appName,
      tagline: b.tagline != null ? b.tagline : null,
      credits: {
        hide: b.credits_hide === '1' || b.credits_hide === 'on',
        lead: b.credits_lead != null ? b.credits_lead : null,
        text: b.credits_text,
        url: b.credits_url,
      },
    });

    const files = req.files || {};
    if (files.logo_file && files.logo_file[0]) {
      const f = files.logo_file[0];
      await brandingLib.setAsset('logo', {
        mime: f.mimetype,
        bytes: f.buffer,
        filename: f.originalname,
      });
    }
    if (files.favicon_file && files.favicon_file[0]) {
      const f = files.favicon_file[0];
      await brandingLib.setAsset('favicon', {
        mime: f.mimetype,
        bytes: f.buffer,
        filename: f.originalname,
      });
    }

    audit.fromReq(req, 'branding.updated', { target_type: 'settings', target_id: 1 });
    req.flash('success', 'Branding updated');
    res.redirect('/settings/branding');
  } catch (err) {
    // brandingLib.setAsset throws plain Errors for validation problems.
    // Treat any branding/asset validation error as a flash redirect.
    if (
      err && err.message
      && /^(unsupported (asset kind|mime type)|empty asset bytes|asset too large)/i.test(err.message)
    ) {
      req.flash('error', err.message);
      return res.redirect('/settings/branding');
    }
    next(err);
  }
});

router.post('/settings/branding/reset', async (req, res, next) => {
  try {
    await brandingLib.update({
      appName: null,
      tagline: null,
      credits: { hide: null, lead: null, text: null, url: null },
    });
    audit.fromReq(req, 'branding.reset', { target_type: 'settings', target_id: 1 });
    req.flash('success', 'Branding reset to defaults');
    res.redirect('/settings/branding');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/branding/logo/delete', async (req, res, next) => {
  try {
    await brandingLib.deleteAsset('logo');
    audit.fromReq(req, 'branding.logo_deleted', { target_type: 'settings', target_id: 1 });
    req.flash('success', 'Custom logo removed');
    res.redirect('/settings/branding');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/branding/favicon/delete', async (req, res, next) => {
  try {
    await brandingLib.deleteAsset('favicon');
    audit.fromReq(req, 'branding.favicon_deleted', { target_type: 'settings', target_id: 1 });
    req.flash('success', 'Custom favicon removed');
    res.redirect('/settings/branding');
  } catch (err) {
    next(err);
  }
});

router.get('/settings/status-page', async (req, res, next) => {
  try {
    const rows = await db.query(
      `SELECT status_page_enabled, status_page_public, status_page_token,
              status_page_title, status_page_description
         FROM settings WHERE id = 1`
    );
    const s = rows[0] || {};
    const groupsRows = await db.query(
      `SELECT COALESCE(NULLIF(status_page_group, ''), '(default / ungrouped)') AS name,
              COUNT(*) AS count
         FROM sites
        WHERE status_page_excluded = 0
        GROUP BY status_page_group
        ORDER BY name ASC`
    );
    res.render('settings-status-page', {
      title: 'Public status page',
      settings: {
        enabled: s.status_page_enabled == null ? true : !!s.status_page_enabled,
        public: s.status_page_public == null ? true : !!s.status_page_public,
        token: s.status_page_token || '',
        title: s.status_page_title || '',
        description: s.status_page_description || '',
      },
      groups: groupsRows,
      publicBaseUrl: config.publicBaseUrl,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/status-page', async (req, res, next) => {
  try {
    const b = req.body || {};
    const enabled = b.enabled === '1' || b.enabled === 'on' ? 1 : 0;
    const isPublic = b.public_mode === 'public' ? 1 : 0;
    let token = (b.token || '').trim();
    // Auto-generate a token when switching to private and none set.
    if (!isPublic && !token) token = crypto.randomBytes(18).toString('base64url');
    const titleVal = (b.title || '').trim().slice(0, 255) || null;
    const descVal = (b.description || '').trim().slice(0, 2000) || null;
    await db.query(
      `UPDATE settings SET
         status_page_enabled = ?, status_page_public = ?, status_page_token = ?,
         status_page_title = ?, status_page_description = ?
       WHERE id = 1`,
      [enabled, isPublic, token || null, titleVal, descVal]
    );
    logger.info({ enabled, public: isPublic }, 'settings.status_page_updated');
    req.flash('success', 'Status page settings saved');
    res.redirect('/settings/status-page');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/status-page/regenerate-token', async (req, res, next) => {
  try {
    const token = crypto.randomBytes(18).toString('base64url');
    await db.query(`UPDATE settings SET status_page_token = ? WHERE id = 1`, [token]);
    req.flash('success', 'New access token generated');
    res.redirect('/settings/status-page');
  } catch (err) {
    next(err);
  }
});

// ─── Maintenance windows ─────────────────────────────────────────────────

const KNOWN_TZS = new Set([
  'UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid',
  'Europe/Rome', 'Europe/Belgrade', 'Europe/Sarajevo', 'Europe/Zagreb',
  'Europe/Vienna', 'Europe/Prague', 'Europe/Warsaw', 'Europe/Helsinki',
  'Europe/Athens', 'Europe/Istanbul', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
  'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Bangkok',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
  'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland',
]);

async function listSitesForPicker() {
  return db.query(`SELECT id, name, monitor_type FROM sites ORDER BY name ASC`);
}

function buildMaintenancePayload(body) {
  const name = (body.name || '').trim().slice(0, 160) || 'Maintenance';
  const enabled = body.enabled === '1' || body.enabled === 'on' ? 1 : 0;
  const scopeRaw = String(body.scope || 'global').toLowerCase();
  const scope = ['global', 'monitor'].includes(scopeRaw) ? scopeRaw : 'global';
  const scope_value = scope === 'monitor' ? String(parseInt(body.scope_value, 10) || 0) || null : null;
  const kindRaw = String(body.kind || 'oneoff').toLowerCase();
  const kind = ['oneoff', 'recurring'].includes(kindRaw) ? kindRaw : 'oneoff';

  let starts_at = null;
  let ends_at = null;
  let cron = null;
  let duration_minutes = null;
  if (kind === 'oneoff') {
    starts_at = (body.starts_at || '').trim() || null;
    ends_at = (body.ends_at || '').trim() || null;
    // Normalize to ISO UTC. <input type="datetime-local"> sends "2026-05-12T13:30"
    // which JS Date treats as *local* time → ISOString converts to UTC.
    if (starts_at) starts_at = new Date(starts_at).toISOString();
    if (ends_at)   ends_at   = new Date(ends_at).toISOString();
  } else {
    cron = (body.cron || '').trim() || null;
    duration_minutes = Math.max(1, Math.min(7 * 24 * 60, parseInt(body.duration_minutes, 10) || 60));
  }
  const tzRaw = (body.timezone || 'UTC').trim();
  const timezone = KNOWN_TZS.has(tzRaw) ? tzRaw : 'UTC';
  const suppress_notifications = body.suppress_notifications === '1' || body.suppress_notifications === 'on' ? 1 : 0;
  const pause_probes = body.pause_probes === '1' || body.pause_probes === 'on' ? 1 : 0;

  return {
    name, enabled, scope, scope_value, kind,
    starts_at, ends_at, cron, duration_minutes, timezone,
    suppress_notifications, pause_probes,
  };
}

function validateMaintenance(data) {
  if (data.kind === 'oneoff') {
    if (!data.starts_at || !data.ends_at) return 'Start and end are required for one-off windows';
    if (new Date(data.starts_at) >= new Date(data.ends_at)) return 'End must be after start';
  } else {
    if (!data.cron) return 'Cron expression is required for recurring windows';
    const v = maintenance.validateCron(data.cron);
    if (!v.ok) return `Invalid cron expression: ${v.error}`;
    if (!data.duration_minutes || data.duration_minutes < 1) return 'Duration must be at least 1 minute';
  }
  if (data.scope === 'monitor' && !data.scope_value) return 'Pick a monitor for monitor-scope windows';
  return null;
}

router.get('/settings/maintenance', async (req, res, next) => {
  try {
    const rows = await maintenance.listWindows({ fresh: true });
    const now = new Date();
    const sites = await listSitesForPicker();
    const sitesById = new Map(sites.map((s) => [s.id, s]));
    const enriched = rows.map((w) => ({
      ...w,
      summary: maintenance.summarize(w, now),
      active: maintenance.windowIsActive(w, now),
      target_label: w.scope === 'global'
        ? 'all monitors'
        : (sitesById.get(Number(w.scope_value))?.name || `monitor #${w.scope_value}`),
    }));
    res.render('settings-maintenance', {
      title: 'Maintenance windows',
      windows: enriched,
      activeCount: enriched.filter((w) => w.active).length,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/settings/maintenance/new', async (req, res, next) => {
  try {
    const sites = await listSitesForPicker();
    res.render('settings-maintenance-form', {
      title: 'New maintenance window',
      window: {
        name: '', enabled: 1, scope: 'global', scope_value: null,
        kind: 'oneoff', starts_at: '', ends_at: '',
        cron: '0 2 * * 0', duration_minutes: 60, timezone: 'UTC',
        suppress_notifications: 1, pause_probes: 0,
      },
      sites,
      knownTimezones: [...KNOWN_TZS],
      formAction: '/settings/maintenance',
      submitLabel: 'Create window',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/maintenance', async (req, res, next) => {
  try {
    const data = buildMaintenancePayload(req.body);
    const err = validateMaintenance(data);
    if (err) {
      req.flash('error', err);
      return res.redirect('/settings/maintenance/new');
    }
    await db.query(
      `INSERT INTO maintenance_windows
         (name, enabled, scope, scope_value, kind, starts_at, ends_at,
          cron, duration_minutes, timezone, suppress_notifications, pause_probes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.name, data.enabled, data.scope, data.scope_value, data.kind,
        data.starts_at, data.ends_at, data.cron, data.duration_minutes,
        data.timezone, data.suppress_notifications, data.pause_probes,
      ]
    );
    maintenance.invalidateCache();
    logger.info({ name: data.name, scope: data.scope, kind: data.kind }, 'maintenance.created');
    req.flash('success', `Maintenance window "${data.name}" created`);
    res.redirect('/settings/maintenance');
  } catch (e) {
    next(e);
  }
});

router.get('/settings/maintenance/:id/edit', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.status(404).render('error', { title: 'Not found', error: 'Maintenance window not found' });
    const w = await maintenance.getWindow(id);
    if (!w) return res.status(404).render('error', { title: 'Not found', error: 'Maintenance window not found' });
    const sites = await listSitesForPicker();
    res.render('settings-maintenance-form', {
      title: `Edit ${w.name}`,
      window: w,
      sites,
      knownTimezones: [...KNOWN_TZS],
      formAction: `/settings/maintenance/${id}/edit`,
      submitLabel: 'Save changes',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/maintenance/:id/edit', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/maintenance');
    const data = buildMaintenancePayload(req.body);
    const err = validateMaintenance(data);
    if (err) {
      req.flash('error', err);
      return res.redirect(`/settings/maintenance/${id}/edit`);
    }
    await db.query(
      `UPDATE maintenance_windows SET
         name=?, enabled=?, scope=?, scope_value=?, kind=?,
         starts_at=?, ends_at=?, cron=?, duration_minutes=?, timezone=?,
         suppress_notifications=?, pause_probes=?
       WHERE id=?`,
      [
        data.name, data.enabled, data.scope, data.scope_value, data.kind,
        data.starts_at, data.ends_at, data.cron, data.duration_minutes,
        data.timezone, data.suppress_notifications, data.pause_probes,
        id,
      ]
    );
    maintenance.invalidateCache();
    logger.info({ id, name: data.name }, 'maintenance.updated');
    req.flash('success', 'Maintenance window updated');
    res.redirect('/settings/maintenance');
  } catch (e) {
    next(e);
  }
});

router.post('/settings/maintenance/:id/toggle', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/maintenance');
    const cur = await maintenance.getWindow(id);
    if (!cur) return res.redirect('/settings/maintenance');
    const nextVal = cur.enabled ? 0 : 1;
    await db.query(`UPDATE maintenance_windows SET enabled=? WHERE id=?`, [nextVal, id]);
    maintenance.invalidateCache();
    req.flash('success', nextVal ? 'Window enabled' : 'Window disabled');
    res.redirect('/settings/maintenance');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/maintenance/:id/delete', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/maintenance');
    await db.query(`DELETE FROM maintenance_windows WHERE id=?`, [id]);
    maintenance.invalidateCache();
    logger.info({ id }, 'maintenance.deleted');
    req.flash('success', 'Maintenance window deleted');
    res.redirect('/settings/maintenance');
  } catch (err) {
    next(err);
  }
});

// ─── API tokens (admin view: every token in the system) ──────────────────
// DB users see their own tokens at /settings/account.
router.get('/settings/api-tokens', async (req, res, next) => {
  try {
    const tokens = await apiTokens.listTokens();
    // Decorate with owner username for the admin view.
    const userIds = [...new Set(tokens.map((t) => t.user_id).filter((id) => id != null))];
    const userMap = new Map();
    if (userIds.length) {
      const ph = userIds.map(() => '?').join(',');
      const rows = await db.query(`SELECT id, username FROM users WHERE id IN (${ph})`, userIds);
      for (const r of rows) userMap.set(Number(r.id), r.username);
    }
    const decorated = tokens.map((t) => ({
      ...t,
      owner_username: t.user_id == null ? `env: ${config.admin.user}` : (userMap.get(Number(t.user_id)) || `user #${t.user_id}`),
    }));
    res.render('settings-api-tokens', {
      title: 'API tokens',
      tokens: decorated,
      newToken: req.session.newApiToken || null,
      publicBaseUrl: config.publicBaseUrl,
    });
    delete req.session.newApiToken;
  } catch (err) { next(err); }
});

router.post('/settings/api-tokens', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const scope = req.body.scope === 'write' ? 'write' : 'read';
    if (!name) {
      req.flash('error', 'Token name is required');
      return res.redirect('/settings/api-tokens');
    }
    // Admins minting from this page get an env-owned token (user_id NULL).
    // Per-user tokens live at /settings/account.
    const result = await apiTokens.createToken(name, scope, null);
    req.session.newApiToken = { id: result.id, name: result.name, scope: result.scope, token: result.token };
    audit.fromReq(req, 'api_token.created', { targetType: 'api_token', targetId: result.id, meta: { name: result.name, scope: result.scope } });
    logger.info({ id: result.id, name: result.name, scope: result.scope }, 'api_token.created');
    req.flash('success', `Token "${result.name}" created. Copy it now — it will not be shown again.`);
    res.redirect('/settings/api-tokens');
  } catch (err) { next(err); }
});

router.post('/settings/api-tokens/:id/delete', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/api-tokens');
    await apiTokens.deleteToken(id);
    audit.fromReq(req, 'api_token.deleted', { targetType: 'api_token', targetId: id });
    logger.info({ id }, 'api_token.deleted');
    req.flash('success', 'Token revoked');
    res.redirect('/settings/api-tokens');
  } catch (err) { next(err); }
});

// ─── Two-factor authentication ───────────────────────────────────────────
router.get('/settings/2fa', async (req, res, next) => {
  try {
    const state = await getTotpState();
    let pending = null;
    if (req.session.pendingTotp) {
      const otpauth = authenticator.keyuri(
        req.session.user?.username || 'admin',
        res.locals.branding?.appName || config.branding?.appName || 'Uptime',
        req.session.pendingTotp.secret
      );
      const qrDataUrl = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
      pending = {
        secret: req.session.pendingTotp.secret,
        otpauth,
        qrDataUrl,
      };
    }
    res.render('settings-2fa', {
      title: 'Two-factor',
      enabled: state.enabled,
      recoveryRemaining: state.recoveryCodes ? state.recoveryCodes.length : 0,
      pending,
      newRecoveryCodes: req.session.newRecoveryCodes || null,
    });
    delete req.session.newRecoveryCodes;
  } catch (err) { next(err); }
});

router.post('/settings/2fa/start', async (req, res, next) => {
  try {
    const state = await getTotpState();
    if (state.enabled) {
      req.flash('error', '2FA is already enabled. Disable it first to re-enroll.');
      return res.redirect('/settings/2fa');
    }
    const secret = authenticator.generateSecret();
    req.session.pendingTotp = { secret, ts: Date.now() };
    res.redirect('/settings/2fa');
  } catch (err) { next(err); }
});

router.post('/settings/2fa/cancel', (req, res) => {
  delete req.session.pendingTotp;
  res.redirect('/settings/2fa');
});

router.post('/settings/2fa/enable', async (req, res, next) => {
  try {
    const pending = req.session.pendingTotp;
    if (!pending) {
      req.flash('error', 'No 2FA enrollment in progress');
      return res.redirect('/settings/2fa');
    }
    if (Date.now() - (pending.ts || 0) > 10 * 60 * 1000) {
      delete req.session.pendingTotp;
      req.flash('error', 'Enrollment expired — start again');
      return res.redirect('/settings/2fa');
    }
    const code = String(req.body.code || '').replace(/\s+/g, '');
    if (!authenticator.check(code, pending.secret)) {
      req.flash('error', 'Code did not match. Try the next 30-second cycle.');
      return res.redirect('/settings/2fa');
    }
    const plain = generateRecoveryCodes(10);
    const hashed = plain.map(hashRecovery);
    await saveTotpState({ secret: pending.secret, enabled: true, recoveryCodes: hashed });
    audit.fromReq(req, '2fa.enabled', { meta: { recovery_count: plain.length } });
    delete req.session.pendingTotp;
    req.session.newRecoveryCodes = plain;
    req.flash('success', 'Two-factor authentication enabled.');
    res.redirect('/settings/2fa');
  } catch (err) { next(err); }
});

router.post('/settings/2fa/disable', async (req, res, next) => {
  try {
    const code = String(req.body.code || '').replace(/\s+/g, '');
    const state = await getTotpState();
    if (state.enabled) {
      const ok = authenticator.check(code, state.secret) || state.recoveryCodes.includes(hashRecovery(code));
      if (!ok) {
        req.flash('error', 'Enter a current TOTP or recovery code to disable 2FA');
        return res.redirect('/settings/2fa');
      }
    }
    await saveTotpState({ secret: null, enabled: false, recoveryCodes: [] });
    audit.fromReq(req, '2fa.disabled');
    req.flash('success', 'Two-factor authentication disabled.');
    res.redirect('/settings/2fa');
  } catch (err) { next(err); }
});

router.post('/settings/2fa/regenerate-recovery', async (req, res, next) => {
  try {
    const state = await getTotpState();
    if (!state.enabled) {
      req.flash('error', '2FA is not enabled');
      return res.redirect('/settings/2fa');
    }
    const code = String(req.body.code || '').replace(/\s+/g, '');
    if (!authenticator.check(code, state.secret)) {
      req.flash('error', 'Confirm with a current TOTP code to regenerate recovery codes');
      return res.redirect('/settings/2fa');
    }
    const plain = generateRecoveryCodes(10);
    const hashed = plain.map(hashRecovery);
    await saveTotpState({ ...state, recoveryCodes: hashed });
    audit.fromReq(req, '2fa.recovery_regenerated');
    req.session.newRecoveryCodes = plain;
    req.flash('success', 'New recovery codes generated. Old codes are invalid.');
    res.redirect('/settings/2fa');
  } catch (err) { next(err); }
});

// ─── Audit log ───────────────────────────────────────────────────────────
router.get('/settings/audit', async (req, res, next) => {
  try {
    const action = (req.query.action || '').toString().trim() || null;
    const u = req.session.user;
    const restrictToSelf = !acl.isAdmin(u);
    const entries = await audit.list({
      limit: 200,
      action,
      actorUserId: restrictToSelf ? (u?.id || -1) : null,
    });
    const actions = await audit.listActions({ actorUserId: restrictToSelf ? (u?.id || -1) : null });
    res.render('settings-audit', {
      title: 'Audit log',
      entries: entries.map((e) => ({ ...e, meta_parsed: tryParseJSON(e.meta) })),
      actions,
      filterAction: action,
      restrictedToSelf: restrictToSelf,
    });
  } catch (err) { next(err); }
});

function tryParseJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ─── User management (admin only — gated by router.use above) ────────────
router.get('/settings/users', async (req, res, next) => {
  try {
    const list = await users.list();
    const sitesUnowned = (await db.query(`SELECT COUNT(*) AS c FROM sites WHERE owner_user_id IS NULL`))[0]?.c || 0;
    res.render('settings-users', {
      title: 'Users',
      users: list,
      sitesUnowned,
      reservedUsername: config.admin.user,
      newUser: req.session.newUserCreds || null,
    });
    delete req.session.newUserCreds;
  } catch (err) { next(err); }
});

router.post('/settings/users', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const role = String(req.body.role || 'viewer');
    const email = (req.body.email || '').trim() || null;
    const displayName = (req.body.display_name || '').trim() || null;
    const initialPassword = users.generateInitialPassword();
    const u = await users.create({
      username,
      password: initialPassword,
      role,
      email,
      displayName,
      mustChangePassword: true,
      createdByUserId: req.session.user?.isEnv ? null : req.session.user?.id || null,
    });
    audit.fromReq(req, 'user.created', { targetType: 'user', targetId: u.id, meta: { username: u.username, role: u.role } });
    req.session.newUserCreds = { username: u.username, password: initialPassword, role: u.role };
    req.flash('success', `User "${u.username}" created. Show them the initial password now — it cannot be recovered.`);
    res.redirect('/settings/users');
  } catch (err) {
    req.flash('error', err.message || 'Failed to create user');
    res.redirect('/settings/users');
  }
});

router.post('/settings/users/:id/role', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/users');
    const u = await users.getById(id);
    if (!u) return res.redirect('/settings/users');
    const newRole = String(req.body.role || 'viewer');
    if (u.role === 'admin' && newRole !== 'admin') {
      const adminCount = await users.countAdmins();
      if (adminCount <= 1) {
        req.flash('error', 'Cannot demote the last active DB admin (env admin remains as break-glass).');
        return res.redirect('/settings/users');
      }
    }
    await users.updateRole(id, newRole);
    audit.fromReq(req, 'user.role_changed', { targetType: 'user', targetId: id, meta: { from: u.role, to: newRole } });
    req.flash('success', `Updated ${u.username} → ${newRole}`);
    res.redirect('/settings/users');
  } catch (err) { next(err); }
});

router.post('/settings/users/:id/toggle-disabled', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/users');
    const u = await users.getById(id);
    if (!u) return res.redirect('/settings/users');
    const nextDisabled = !u.disabled;
    if (!nextDisabled === false && u.role === 'admin') {
      // Disabling an admin: make sure at least one active DB admin remains
      // (otherwise the env admin becomes the sole break-glass account).
      const adminCount = await users.countAdmins();
      if (adminCount <= 1) {
        req.flash('warning', 'Disabling the last DB admin — env admin remains as break-glass.');
      }
    }
    await users.setDisabled(id, nextDisabled);
    audit.fromReq(req, 'user.disabled_changed', { targetType: 'user', targetId: id, meta: { disabled: nextDisabled } });
    req.flash('success', nextDisabled ? `${u.username} disabled` : `${u.username} enabled`);
    res.redirect('/settings/users');
  } catch (err) { next(err); }
});

router.post('/settings/users/:id/reset-password', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/users');
    const u = await users.getById(id);
    if (!u) return res.redirect('/settings/users');
    const initialPassword = users.generateInitialPassword();
    await users.setPassword(id, initialPassword, { mustChange: true });
    audit.fromReq(req, 'user.password_reset', { targetType: 'user', targetId: id });
    req.session.newUserCreds = { username: u.username, password: initialPassword, role: u.role, reset: true };
    req.flash('success', `Reset password for ${u.username}. Show them the new password now.`);
    res.redirect('/settings/users');
  } catch (err) { next(err); }
});

router.post('/settings/users/:id/disable-2fa', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/users');
    const u = await users.getById(id);
    if (!u) return res.redirect('/settings/users');
    await users.setTotp(id, { secret: null, enabled: false, recoveryCodes: null });
    audit.fromReq(req, 'user.2fa_disabled_by_admin', { targetType: 'user', targetId: id });
    req.flash('success', `2FA disabled for ${u.username}.`);
    res.redirect('/settings/users');
  } catch (err) { next(err); }
});

router.post('/settings/users/:id/delete', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/users');
    const u = await users.getById(id);
    if (!u) return res.redirect('/settings/users');
    if (req.session.user?.id === id) {
      req.flash('error', 'You cannot delete your own account.');
      return res.redirect('/settings/users');
    }
    if (u.role === 'admin') {
      const adminCount = await users.countAdmins();
      if (adminCount <= 1) {
        req.flash('warning', 'Deleting the last DB admin — env admin remains as break-glass.');
      }
    }
    await users.deleteUser(id);
    audit.fromReq(req, 'user.deleted', { targetType: 'user', targetId: id, meta: { username: u.username } });
    req.flash('success', `User ${u.username} deleted.`);
    res.redirect('/settings/users');
  } catch (err) { next(err); }
});

router.post('/settings/users/claim-unowned', async (req, res, next) => {
  try {
    const u = req.session.user;
    if (!u || u.isEnv || u.id == null) {
      req.flash('error', 'Only a DB user can claim unowned monitors.');
      return res.redirect('/settings/users');
    }
    const n = await users.claimUnownedSites(u.id);
    audit.fromReq(req, 'user.claimed_unowned_sites', { meta: { count: n } });
    req.flash('success', `Claimed ${n} unowned monitor${n === 1 ? '' : 's'}.`);
    res.redirect('/settings/users');
  } catch (err) { next(err); }
});

// Per-user grant editor.
router.get('/settings/users/:id/grants', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/users');
    const target = await users.getById(id);
    if (!target) return res.redirect('/settings/users');
    const allSites = await db.query(`SELECT id, name, monitor_type, owner_user_id FROM sites ORDER BY name ASC`);
    const existing = await grants.listForUser(id);
    const grantMap = new Map(existing.map((g) => [Number(g.site_id), g.permission]));
    res.render('settings-user-grants', {
      title: `Grants — ${target.username}`,
      target,
      allSites,
      grantMap,
    });
  } catch (err) { next(err); }
});

router.post('/settings/users/:id/grants', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/users');
    const target = await users.getById(id);
    if (!target) return res.redirect('/settings/users');
    // Body shape: permissions[<siteId>] = 'none' | 'view' | 'manage'
    const perms = req.body.permissions || {};
    const entries = [];
    for (const [k, v] of Object.entries(perms)) {
      const sid = parseId(k);
      if (sid == null) continue;
      const p = String(v || '').toLowerCase();
      if (p === 'view' || p === 'manage') entries.push({ siteId: sid, permission: p });
    }
    await grants.setManyForUser(id, entries, req.session.user?.isEnv ? null : req.session.user?.id || null);
    audit.fromReq(req, 'user.grants_updated', { targetType: 'user', targetId: id, meta: { count: entries.length } });
    req.flash('success', `Grants saved for ${target.username}`);
    res.redirect(`/settings/users/${id}/grants`);
  } catch (err) { next(err); }
});

// ─── My account (any logged-in user) ─────────────────────────────────────
router.get('/settings/account', async (req, res, next) => {
  try {
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    if (u.isEnv) {
      // Env admin has no user row — show a friendly notice and route them to
      // the singleton 2FA page.
      return res.render('settings-account', {
        title: 'My account',
        isEnv: true,
        myUser: null,
        myTokens: [],
        pending: null,
        newRecoveryCodes: null,
        newToken: null,
      });
    }
    const myUser = await users.getById(u.id);
    if (!myUser) return res.redirect('/logout');
    const myTokens = await db.query(
      `SELECT id, name, scope, last_used_at, created_at FROM api_tokens
        WHERE user_id = ? ORDER BY id DESC`,
      [u.id]
    );
    let pending = null;
    if (req.session.pendingTotp && req.session.pendingTotp.userId === u.id) {
      const otpauth = authenticator.keyuri(
        myUser.username,
        res.locals.branding?.appName || config.branding?.appName || 'Uptime',
        req.session.pendingTotp.secret
      );
      const qrDataUrl = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
      pending = { secret: req.session.pendingTotp.secret, otpauth, qrDataUrl };
    }
    res.render('settings-account', {
      title: 'My account',
      isEnv: false,
      myUser,
      myTokens,
      pending,
      newRecoveryCodes: req.session.newRecoveryCodes || null,
      newToken: req.session.newApiTokenAccount || null,
    });
    delete req.session.newRecoveryCodes;
    delete req.session.newApiTokenAccount;
  } catch (err) { next(err); }
});

router.post('/settings/account/profile', async (req, res, next) => {
  try {
    const u = req.session.user;
    if (!u || u.isEnv) return res.redirect('/settings/account');
    await users.setProfile(u.id, {
      email: req.body.email || null,
      displayName: req.body.display_name || null,
    });
    audit.fromReq(req, 'account.profile_updated');
    req.flash('success', 'Profile updated');
    res.redirect('/settings/account');
  } catch (err) { next(err); }
});

router.post('/settings/account/password', async (req, res, next) => {
  try {
    const u = req.session.user;
    if (!u || u.isEnv) return res.redirect('/settings/account');
    const cur = await users.findByUsername(u.username);
    if (!cur) return res.redirect('/logout');
    const currentPw = String(req.body.current_password || '');
    const newPw = String(req.body.new_password || '');
    const repeat = String(req.body.repeat_password || '');
    // First-time forced change waives the current-password check.
    if (!cur.must_change_password) {
      const ok = await users.verifyPassword(cur.password_hash, currentPw);
      if (!ok) {
        req.flash('error', 'Current password is incorrect');
        return res.redirect('/settings/account');
      }
    }
    if (newPw.length < 8) {
      req.flash('error', 'New password must be at least 8 characters');
      return res.redirect('/settings/account');
    }
    if (newPw !== repeat) {
      req.flash('error', 'New password and confirmation do not match');
      return res.redirect('/settings/account');
    }
    await users.setPassword(u.id, newPw, { mustChange: false });
    req.session.user.mustChangePassword = false;
    audit.fromReq(req, 'account.password_changed');
    req.flash('success', 'Password updated');
    res.redirect('/settings/account');
  } catch (err) { next(err); }
});

// Per-user 2FA — operates on the users row (not the singleton).
router.post('/settings/account/2fa/start', async (req, res, next) => {
  try {
    const u = req.session.user;
    if (!u || u.isEnv) return res.redirect('/settings/account');
    const state = await getUserTotpState(u.id);
    if (state.enabled) {
      req.flash('error', '2FA is already enabled. Disable it first to re-enroll.');
      return res.redirect('/settings/account');
    }
    const secret = authenticator.generateSecret();
    req.session.pendingTotp = { userId: u.id, secret, ts: Date.now() };
    res.redirect('/settings/account');
  } catch (err) { next(err); }
});

router.post('/settings/account/2fa/cancel', (req, res) => {
  delete req.session.pendingTotp;
  res.redirect('/settings/account');
});

router.post('/settings/account/2fa/enable', async (req, res, next) => {
  try {
    const u = req.session.user;
    if (!u || u.isEnv) return res.redirect('/settings/account');
    const pending = req.session.pendingTotp;
    if (!pending || pending.userId !== u.id) {
      req.flash('error', 'No 2FA enrollment in progress');
      return res.redirect('/settings/account');
    }
    if (Date.now() - (pending.ts || 0) > 10 * 60 * 1000) {
      delete req.session.pendingTotp;
      req.flash('error', 'Enrollment expired — start again');
      return res.redirect('/settings/account');
    }
    const code = String(req.body.code || '').replace(/\s+/g, '');
    if (!authenticator.check(code, pending.secret)) {
      req.flash('error', 'Code did not match. Try the next 30-second cycle.');
      return res.redirect('/settings/account');
    }
    const plain = generateRecoveryCodes(10);
    const hashed = plain.map(hashRecovery);
    await saveUserTotpState(u.id, { secret: pending.secret, enabled: true, recoveryCodes: hashed });
    delete req.session.pendingTotp;
    req.session.newRecoveryCodes = plain;
    audit.fromReq(req, 'account.2fa_enabled');
    req.flash('success', 'Two-factor authentication enabled.');
    res.redirect('/settings/account');
  } catch (err) { next(err); }
});

router.post('/settings/account/2fa/disable', async (req, res, next) => {
  try {
    const u = req.session.user;
    if (!u || u.isEnv) return res.redirect('/settings/account');
    const state = await getUserTotpState(u.id);
    if (state.enabled) {
      const code = String(req.body.code || '').replace(/\s+/g, '');
      const totpOk = authenticator.check(code, state.secret);
      const recOk = state.recoveryCodes?.includes(hashRecovery(code));
      if (!totpOk && !recOk) {
        req.flash('error', 'Enter a current TOTP or recovery code to disable 2FA');
        return res.redirect('/settings/account');
      }
    }
    await saveUserTotpState(u.id, { secret: null, enabled: false, recoveryCodes: [] });
    audit.fromReq(req, 'account.2fa_disabled');
    req.flash('success', 'Two-factor authentication disabled.');
    res.redirect('/settings/account');
  } catch (err) { next(err); }
});

router.post('/settings/account/2fa/regenerate', async (req, res, next) => {
  try {
    const u = req.session.user;
    if (!u || u.isEnv) return res.redirect('/settings/account');
    const state = await getUserTotpState(u.id);
    if (!state.enabled) {
      req.flash('error', '2FA is not enabled');
      return res.redirect('/settings/account');
    }
    const code = String(req.body.code || '').replace(/\s+/g, '');
    if (!authenticator.check(code, state.secret)) {
      req.flash('error', 'Confirm with a current TOTP code to regenerate recovery codes');
      return res.redirect('/settings/account');
    }
    const plain = generateRecoveryCodes(10);
    const hashed = plain.map(hashRecovery);
    await saveUserTotpState(u.id, { ...state, recoveryCodes: hashed });
    req.session.newRecoveryCodes = plain;
    audit.fromReq(req, 'account.2fa_recovery_regenerated');
    req.flash('success', 'New recovery codes generated. Old codes are invalid.');
    res.redirect('/settings/account');
  } catch (err) { next(err); }
});

// Per-user API tokens (scoped to the current user).
router.post('/settings/account/tokens', async (req, res, next) => {
  try {
    const u = req.session.user;
    if (!u || u.isEnv) return res.redirect('/settings/account');
    const name = (req.body.name || '').trim();
    const scope = req.body.scope === 'write' ? 'write' : 'read';
    if (!name) {
      req.flash('error', 'Token name is required');
      return res.redirect('/settings/account');
    }
    const result = await apiTokens.createToken(name, scope, u.id);
    req.session.newApiTokenAccount = { id: result.id, name: result.name, scope: result.scope, token: result.token };
    audit.fromReq(req, 'account.api_token_created', { targetType: 'api_token', targetId: result.id, meta: { name: result.name, scope: result.scope } });
    req.flash('success', `Token "${result.name}" created. Copy it now — it will not be shown again.`);
    res.redirect('/settings/account');
  } catch (err) { next(err); }
});

router.post('/settings/account/tokens/:id/delete', async (req, res, next) => {
  try {
    const u = req.session.user;
    if (!u || u.isEnv) return res.redirect('/settings/account');
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/account');
    // Refuse to delete tokens that don't belong to the caller.
    const owned = await db.query(
      `SELECT id FROM api_tokens WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, u.id]
    );
    if (!owned.length) {
      req.flash('error', 'Token not found');
      return res.redirect('/settings/account');
    }
    await apiTokens.deleteToken(id);
    audit.fromReq(req, 'account.api_token_deleted', { targetType: 'api_token', targetId: id });
    req.flash('success', 'Token revoked');
    res.redirect('/settings/account');
  } catch (err) { next(err); }
});

module.exports = router;
