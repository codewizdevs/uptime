'use strict';

const express = require('express');
const db = require('../db');
const monitor = require('../monitor');
const logger = require('../logger');

const router = express.Router();

async function handle(req, res, isHead) {
  const token = (req.params.token || '').trim();
  if (!/^[a-f0-9]{16,64}$/i.test(token)) {
    return res.status(404).type('text/plain').send(isHead ? '' : 'NOT FOUND');
  }
  const rows = await db.query(
    `SELECT id, name, paused, monitor_type, current_state,
            url, interval_seconds, heartbeat_grace_seconds, failure_threshold
       FROM sites WHERE heartbeat_token = ? AND monitor_type='heartbeat' LIMIT 1`,
    [token]
  );
  const site = rows[0];
  if (!site) {
    logger.warn({ ip: req.ip, ua: req.get('user-agent') }, 'ping.unknown_token');
    return res.status(404).type('text/plain').send(isHead ? '' : 'NOT FOUND');
  }
  if (site.paused) {
    logger.info({ siteId: site.id, ip: req.ip }, 'ping.received_while_paused');
    return res.status(410).type('text/plain').send(isHead ? '' : 'GONE: monitor paused');
  }

  logger.info({ siteId: site.id, name: site.name, ip: req.ip, ua: req.get('user-agent') }, 'ping.received');

  if (!isHead) {
    res.status(200).type('text/plain').send('OK');
  } else {
    res.status(200).end();
  }

  monitor.recordHeartbeatPing(site).catch((err) => {
    logger.error({ err, siteId: site.id }, 'ping.record_failed');
  });
}

router.get('/ping/:token', (req, res, next) => handle(req, res, false).catch(next));
router.head('/ping/:token', (req, res, next) => handle(req, res, true).catch(next));

module.exports = router;
