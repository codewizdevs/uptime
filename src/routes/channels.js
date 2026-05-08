'use strict';

const express = require('express');
const channels = require('../lib/channels');
const logger = require('../logger');
const { idParam } = require('../lib/ids');

const router = express.Router();
router.param('id', idParam);

function parseHeadersJson(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('headers must be a JSON object');
    return v;
  } catch (e) {
    throw new Error('Invalid JSON in headers: ' + e.message);
  }
}

function pickTemplates(body) {
  const out = {};
  for (const ev of channels.EVENT_TYPES) {
    out[ev] = {
      title: typeof body[`tpl_${ev}_title`] === 'string' ? body[`tpl_${ev}_title`] : '',
      body: typeof body[`tpl_${ev}_body`] === 'string' ? body[`tpl_${ev}_body`] : '',
    };
  }
  return out;
}

function buildPayload(body) {
  if (!body || typeof body !== 'object' || !body.type) {
    throw new Error('Channel form was empty - please pick a type and fill in the fields');
  }
  if (!['discord', 'webhook', 'email'].includes(body.type)) {
    throw new Error('Invalid channel type');
  }
  const rawName = (body.name || '').trim();
  if (!rawName) {
    throw new Error('Channel name is required');
  }
  const type = body.type;
  const enabled = body.enabled === '1' || body.enabled === 'on' ? 1 : 0;
  const name = rawName;
  const templates = pickTemplates(body);

  let config = {};
  if (type === 'discord') {
    config = { webhook_url: (body.webhook_url || '').trim(), templates };
  } else if (type === 'webhook') {
    config = {
      url: (body.url || '').trim(),
      method: (body.method || 'POST').toUpperCase(),
      content_type: (body.content_type || 'application/json').trim(),
      headers: parseHeadersJson(body.headers_json),
      templates,
    };
  } else if (type === 'email') {
    const to = (body.to_emails || '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    config = { to, templates };
  }

  return { name, type, enabled, config };
}

router.get('/channels', async (req, res, next) => {
  try {
    const list = await channels.listChannels();
    res.render('channels', { title: 'Notification channels', channels: list });
  } catch (err) {
    next(err);
  }
});

router.get('/channels/new', (req, res) => {
  const type = ['discord', 'webhook', 'email'].includes(req.query.type) ? req.query.type : 'discord';
  res.render('channel-form', {
    title: 'New channel',
    formAction: '/channels',
    submitLabel: 'Create channel',
    channel: {
      name: '',
      type,
      enabled: 1,
      config: { templates: channels.emptyTemplates(), ...(type === 'webhook' ? { method: 'POST', content_type: 'application/json', headers: {} } : {}) },
    },
    DEFAULT_TEMPLATES: channels.DEFAULT_TEMPLATES,
    PLACEHOLDERS: channels.PLACEHOLDERS,
    EVENT_TYPES: channels.EVENT_TYPES,
  });
});

router.post('/channels', async (req, res, next) => {
  try {
    const data = buildPayload(req.body);
    const id = await channels.createChannel(data);
    req.flash('success', `Channel "${data.name}" created`);
    res.redirect(`/channels/${id}/edit`);
  } catch (err) {
    if (err.message?.startsWith('Invalid JSON') || err.message?.startsWith('Channel') || err.message?.startsWith('Invalid channel')) {
      req.flash('error', err.message);
      return res.redirect('/channels/new?type=' + (req.body?.type || 'discord'));
    }
    next(err);
  }
});

router.get('/channels/:id/edit', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ch = await channels.getChannel(id);
    if (!ch) return res.status(404).render('error', { title: 'Not found', error: 'Channel not found' });
    if (!ch.config.templates) ch.config.templates = channels.emptyTemplates();
    res.render('channel-form', {
      title: `Edit "${ch.name}"`,
      formAction: `/channels/${id}/edit`,
      submitLabel: 'Save changes',
      channel: ch,
      DEFAULT_TEMPLATES: channels.DEFAULT_TEMPLATES,
      PLACEHOLDERS: channels.PLACEHOLDERS,
      EVENT_TYPES: channels.EVENT_TYPES,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/channels/:id/edit', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = buildPayload(req.body);
    await channels.updateChannel(id, data);
    req.flash('success', 'Channel updated');
    res.redirect(`/channels/${id}/edit`);
  } catch (err) {
    if (err.message?.startsWith('Invalid JSON') || err.message?.startsWith('Channel') || err.message?.startsWith('Invalid channel')) {
      req.flash('error', err.message);
      return res.redirect(`/channels/${req.params.id}/edit`);
    }
    next(err);
  }
});

router.post('/channels/:id/delete', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await channels.deleteChannel(id);
    req.flash('success', 'Channel deleted');
    res.redirect('/channels');
  } catch (err) {
    next(err);
  }
});

router.post('/channels/:id/test', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await channels.testChannel(id);
    req.flash('success', 'Test message sent (or logged in dry-run if APP_DEBUG=true)');
    res.redirect(`/channels/${id}/edit`);
  } catch (err) {
    logger.error({ err, channelId: req.params.id }, 'channels.test_failed');
    req.flash('error', 'Test failed: ' + err.message);
    res.redirect(`/channels/${req.params.id}/edit`);
  }
});

module.exports = router;
