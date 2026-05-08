'use strict';

const nodemailer = require('nodemailer');
const db = require('../db');
const config = require('../config');
const logger = require('../logger');

async function getSettings() {
  const rows = await db.query('SELECT * FROM settings WHERE id = 1');
  return rows[0] || null;
}

async function updateSettings(payload) {
  const fields = [
    'smtp_host',
    'smtp_port',
    'smtp_secure',
    'smtp_user',
    'smtp_pass',
    'smtp_from_address',
    'smtp_from_name',
  ];
  const sets = fields.map((f) => `${f} = ?`).join(', ');
  const values = fields.map((f) => payload[f]);
  await db.query(`UPDATE settings SET ${sets} WHERE id = 1`, values);
  logger.info({ smtp_host: payload.smtp_host, smtp_port: payload.smtp_port }, 'settings.smtp_updated');
}

function isConfigured(s) {
  return !!(s && s.smtp_host && s.smtp_from_address);
}

function buildTransport(s) {
  return nodemailer.createTransport({
    host: s.smtp_host,
    port: Number(s.smtp_port) || 587,
    secure: !!s.smtp_secure,
    auth:
      s.smtp_user && s.smtp_pass
        ? { user: s.smtp_user, pass: s.smtp_pass }
        : undefined,
  });
}

function fromAddress(s) {
  if (s.smtp_from_name) return `"${s.smtp_from_name}" <${s.smtp_from_address}>`;
  return s.smtp_from_address;
}

async function sendMail({ to, subject, text, html }) {
  const s = await getSettings();
  if (!isConfigured(s)) {
    throw new Error('SMTP is not configured. Visit Settings -> Email to set host/port and from address.');
  }
  if (config.appDebug) {
    logger.info(
      { to, subject, fromAddress: fromAddress(s), bodyPreview: (text || '').slice(0, 200) },
      '[email:dry-run] APP_DEBUG=true, message NOT sent'
    );
    return { dryRun: true };
  }
  const transport = buildTransport(s);
  const info = await transport.sendMail({
    from: fromAddress(s),
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    text,
    html,
  });
  logger.info({ messageId: info.messageId, to, subject }, 'email.delivered');
  return info;
}

async function verifyConnection() {
  const s = await getSettings();
  if (!isConfigured(s)) throw new Error('SMTP is not configured');
  const transport = buildTransport(s);
  await transport.verify();
  return true;
}

module.exports = { getSettings, updateSettings, isConfigured, sendMail, verifyConnection, fromAddress };
