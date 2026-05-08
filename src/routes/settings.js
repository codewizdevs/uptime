'use strict';

const express = require('express');
const email = require('../lib/email');
const logger = require('../logger');

const router = express.Router();

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

module.exports = router;
