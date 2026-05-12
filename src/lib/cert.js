'use strict';

// Lightweight TLS cert inspector. Used in two places:
//   1. As a best-effort side-channel from every successful HTTPS probe in
//      checker.js — so the dashboard always shows accurate expiry data.
//   2. As the primary check for monitor_type === 'cert' — no HTTP at all,
//      just the handshake. Useful for SMTPS / IMAPS / FTPS / custom ports.

const tls = require('tls');

function normalizeName(target) {
  // Accept "host", "host:port", or full URL ("https://host[:port]").
  let host = target;
  let port = 443;
  if (/^[a-z]+:\/\//i.test(target)) {
    try {
      const u = new URL(target);
      host = u.hostname;
      if (u.port) port = parseInt(u.port, 10);
      else if (u.protocol === 'http:') port = 80;
      // Default for https stays 443; for other schemes we still default
      // to 443 because we always do TLS.
    } catch {
      // fall through, treat as plain string
    }
  } else {
    const m = /^(.+?):(\d+)$/.exec(target);
    if (m) {
      host = m[1];
      port = parseInt(m[2], 10);
    }
  }
  return { host: String(host || '').trim(), port: Number(port) || 443 };
}

function parseDate(d) {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t) : null;
}

function summarizeCert(cert) {
  if (!cert || !cert.subject) return null;
  const validFrom = parseDate(cert.valid_from);
  const validTo = parseDate(cert.valid_to);
  const daysRemaining = validTo
    ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
    : null;
  const subject = cert.subject?.CN || cert.subject?.O || '';
  const issuer = cert.issuer?.CN || cert.issuer?.O || '';
  let san = [];
  if (typeof cert.subjectaltname === 'string') {
    san = cert.subjectaltname
      .split(',')
      .map((s) => s.trim().replace(/^DNS:/i, '').replace(/^IP Address:/i, ''))
      .filter(Boolean);
  }
  return {
    subject,
    issuer,
    valid_from: validFrom ? validFrom.toISOString() : null,
    valid_to: validTo ? validTo.toISOString() : null,
    days_remaining: daysRemaining,
    san,
    serial: cert.serialNumber || null,
    fingerprint: cert.fingerprint256 || cert.fingerprint || null,
  };
}

// Resolve the peer cert chain via tls.connect. Honors SNI by default.
// `options.rejectUnauthorized` defaults to true; pass false to inspect an
// expired or self-signed cert without erroring out. `timeoutMs` defaults
// to 8 seconds.
async function inspect(target, options = {}) {
  const { host, port } = normalizeName(target);
  if (!host) throw new Error('cert.inspect: empty host');
  const timeoutMs = Math.max(1000, options.timeoutMs || 8000);
  const rejectUnauthorized = options.rejectUnauthorized !== false; // default true

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(value);
    };

    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        ALPNProtocols: ['h2', 'http/1.1'],
        rejectUnauthorized,
        timeout: timeoutMs,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate(true);
          const proto = socket.getProtocol?.() || null;
          const cipher = socket.getCipher?.() || null;
          const summary = summarizeCert(cert);
          settle(null, {
            ok: true,
            host,
            port,
            authorized: socket.authorized,
            authorization_error: socket.authorizationError || null,
            tls_version: proto,
            cipher: cipher?.name || null,
            cert: summary,
          });
        } catch (e) {
          settle(e);
        }
      }
    );

    socket.once('error', (err) => settle(err));
    socket.once('timeout', () => settle(new Error('cert.inspect: timeout')));
  });
}

module.exports = { inspect, normalizeName };
