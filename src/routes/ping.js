'use strict';

const express = require('express');
const db = require('../db');
const monitor = require('../monitor');
const logger = require('../logger');

const router = express.Router();

// Best-effort body capture for /ping/*. By the time we get here the
// app-level urlencoded/json parsers may already have consumed the stream
// into `req.body`. If that's the case we serialize the parsed object; if
// not (raw text/binary content-types), we read the raw socket directly.
const MAX_BODY = 16 * 1024;

function captureRawBody(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'PUT') {
    req.rawBody = null;
    return next();
  }
  // If a parser already populated req.body, prefer that.
  const parsed = req.body;
  if (parsed != null && (typeof parsed === 'object' ? Object.keys(parsed).length : String(parsed).length)) {
    try {
      const ct = String(req.get('content-type') || '').toLowerCase();
      if (ct.includes('application/x-www-form-urlencoded')) {
        const pairs = Object.entries(parsed).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`);
        req.rawBody = Buffer.from(pairs.join('\n').slice(0, MAX_BODY), 'utf8');
      } else if (ct.includes('application/json')) {
        req.rawBody = Buffer.from(JSON.stringify(parsed).slice(0, MAX_BODY), 'utf8');
      } else {
        req.rawBody = Buffer.from(String(parsed).slice(0, MAX_BODY), 'utf8');
      }
    } catch {
      req.rawBody = null;
    }
    return next();
  }
  // Otherwise read raw bytes from the socket.
  const chunks = [];
  let total = 0;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total <= MAX_BODY) chunks.push(chunk);
  });
  req.on('end', () => {
    req.rawBody = chunks.length ? Buffer.concat(chunks).slice(0, MAX_BODY) : null;
    next();
  });
  req.on('error', (err) => next(err));
}

async function loadSiteByToken(token) {
  const rows = await db.query(
    `SELECT * FROM sites WHERE heartbeat_token = ? AND monitor_type='heartbeat' LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

function classifyStatusSegment(seg) {
  if (seg == null || seg === '') return { kind: 'success', exitCode: 0 };
  const lower = String(seg).toLowerCase();
  if (lower === 'start')   return { kind: 'start', exitCode: null };
  if (lower === 'success' || lower === 'ok') return { kind: 'success', exitCode: 0 };
  if (lower === 'fail' || lower === 'failure' || lower === 'down') return { kind: 'failure', exitCode: 1 };
  if (/^-?\d+$/.test(lower)) {
    const code = parseInt(lower, 10);
    if (code === 0) return { kind: 'success', exitCode: 0 };
    return { kind: 'failure', exitCode: code };
  }
  return null;
}

async function handle(req, res, isHead) {
  const token = (req.params.token || '').trim();
  if (!/^[a-f0-9]{16,64}$/i.test(token)) {
    return res.status(404).type('text/plain').send(isHead ? '' : 'NOT FOUND');
  }
  const seg = (req.params.status || '').trim();
  const classification = classifyStatusSegment(seg);
  if (!classification) {
    return res.status(404).type('text/plain').send(isHead ? '' : 'NOT FOUND');
  }
  const site = await loadSiteByToken(token);
  if (!site) {
    logger.warn({ ip: req.ip, ua: req.get('user-agent') }, 'ping.unknown_token');
    return res.status(404).type('text/plain').send(isHead ? '' : 'NOT FOUND');
  }
  if (site.paused) {
    logger.info({ siteId: site.id, ip: req.ip }, 'ping.received_while_paused');
    return res.status(410).type('text/plain').send(isHead ? '' : 'GONE: monitor paused');
  }

  logger.info(
    { siteId: site.id, name: site.name, kind: classification.kind, exit: classification.exitCode, ip: req.ip },
    'ping.received'
  );

  if (isHead) {
    res.status(200).end();
  } else {
    res.status(200).type('text/plain').send('OK');
  }

  monitor.recordHeartbeatPing(site, {
    kind: classification.kind,
    exitCode: classification.exitCode,
    body: req.rawBody,
    sourceIp: req.ip,
    userAgent: req.get('user-agent'),
  }).catch((err) => {
    logger.error({ err, siteId: site.id }, 'ping.record_failed');
  });
}

// Apply raw-body capture on every /ping/* route, then dispatch by method.
router.use('/ping/:token/:status?', captureRawBody);

router.get('/ping/:token',         (req, res, next) => handle(req, res, false).catch(next));
router.head('/ping/:token',        (req, res, next) => handle(req, res, true).catch(next));
router.post('/ping/:token',        (req, res, next) => handle(req, res, false).catch(next));
router.put('/ping/:token',         (req, res, next) => handle(req, res, false).catch(next));

router.get('/ping/:token/:status', (req, res, next) => handle(req, res, false).catch(next));
router.head('/ping/:token/:status',(req, res, next) => handle(req, res, true).catch(next));
router.post('/ping/:token/:status',(req, res, next) => handle(req, res, false).catch(next));
router.put('/ping/:token/:status', (req, res, next) => handle(req, res, false).catch(next));

module.exports = router;
