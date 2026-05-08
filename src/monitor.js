'use strict';

const db = require('./db');
const logger = require('./logger');
const { runCheck, evaluateHeartbeat } = require('./lib/checker');
const cf = require('./lib/cloudflare');
const notifier = require('./notifier');

const INCONCLUSIVE_STREAK_ALERT = 5;
const WATCHDOG_INTERVAL_MS = 15_000;

const state = new Map();

function getState(siteId) {
  let s = state.get(siteId);
  if (!s) {
    s = {
      timer: null,
      consecutiveFailures: 0,
      consecutiveInconclusive: 0,
      cfStreakAlerted: false,
      currentInterval: null,
      lastResultIsUp: null,
      lastError: null,
      stopping: false,
    };
    state.set(siteId, s);
  }
  return s;
}

async function loadSite(id) {
  const rows = await db.query('SELECT * FROM sites WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function recordCheck(site, result) {
  await db.query(
    `INSERT INTO checks (site_id, is_up, status_code, response_time_ms, error_message)
     VALUES (?, ?, ?, ?, ?)`,
    [site.id, result.isUp, result.statusCode, result.responseTimeMs, result.errorMessage]
  );
}

async function openIncident(site, error) {
  await db.query(
    `INSERT INTO incidents (site_id, last_error) VALUES (?, ?)`,
    [site.id, error || null]
  );
  await db.query(`UPDATE sites SET current_state='down' WHERE id=?`, [site.id]);
}

async function closeOpenIncident(site) {
  const open = await db.query(
    `SELECT id, started_at FROM incidents WHERE site_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [site.id]
  );
  if (!open.length) {
    await db.query(`UPDATE sites SET current_state='up' WHERE id=?`, [site.id]);
    return 0;
  }
  const inc = open[0];
  await db.query(
    `UPDATE incidents
       SET ended_at = ${db.nowMs()},
           duration_seconds = ${db.greatestSql('1', db.diffSecondsSql('started_at', db.nowMs()))}
     WHERE id = ?`,
    [inc.id]
  );
  const updated = await db.query(`SELECT duration_seconds FROM incidents WHERE id = ?`, [inc.id]);
  await db.query(`UPDATE sites SET current_state='up' WHERE id=?`, [site.id]);
  return Number(updated[0]?.duration_seconds || 0);
}

async function processResult(site, result) {
  const s = getState(site.id);

  await recordCheck(site, result);

  if (result.isUp === null) {
    s.consecutiveInconclusive += 1;
    s.lastError = result.errorMessage;
    logger.debug(
      { siteId: site.id, consecutiveInconclusive: s.consecutiveInconclusive, reason: result.errorMessage },
      'monitor.inconclusive'
    );
    if (
      site.cloudflare_mode &&
      !s.cfStreakAlerted &&
      s.consecutiveInconclusive >= INCONCLUSIVE_STREAK_ALERT
    ) {
      s.cfStreakAlerted = true;
      await notifier.notifyChallenged(site, s.consecutiveInconclusive);
    }
    return;
  }

  s.consecutiveInconclusive = 0;
  s.cfStreakAlerted = false;

  if (result.isUp === 1) {
    s.consecutiveFailures = 0;
    s.lastError = null;
    if (s.lastResultIsUp === 0 || site.current_state === 'down') {
      const duration = await closeOpenIncident(site);
      logger.info({ siteId: site.id, durationSec: duration }, 'monitor.recovered');
      await notifier.notifyRecovered(site, duration);
    } else if (site.current_state !== 'up') {
      await db.query(`UPDATE sites SET current_state='up' WHERE id=?`, [site.id]);
    }
    s.lastResultIsUp = 1;
    return;
  }

  s.consecutiveFailures += 1;
  s.lastError = result.errorMessage;
  const threshold = Math.max(1, site.failure_threshold || 1);

  logger.debug(
    { siteId: site.id, consecutiveFailures: s.consecutiveFailures, threshold, error: result.errorMessage },
    'monitor.failure'
  );

  if (s.consecutiveFailures >= threshold && site.current_state !== 'down') {
    await openIncident(site, result.errorMessage);
    logger.warn({ siteId: site.id, error: result.errorMessage }, 'monitor.went_down');
    await notifier.notifyDown(site, result.errorMessage);
  }
  s.lastResultIsUp = 0;
}

function computeNextDelaySeconds(site, result) {
  const base = Math.max(10, site.interval_seconds || 60);
  const s = getState(site.id);

  if (site.cloudflare_mode) {
    const floor = Math.max(cf.MIN_CF_INTERVAL, base);
    if (result?.challenged) {
      const next = cf.nextBackoff(s.currentInterval || floor, floor);
      s.currentInterval = next;
      logger.info({ siteId: site.id, backoffSeconds: next }, 'cloudflare.backoff_applied');
      return cf.applyJitter(next, 0.05);
    }
    s.currentInterval = floor;
    return cf.applyJitter(floor, 0.05);
  }

  s.currentInterval = base;
  return cf.applyJitter(base, 0.05);
}

async function tick(siteId) {
  const s = getState(siteId);
  if (s.stopping) return;

  const site = await loadSite(siteId);
  if (!site) {
    logger.warn({ siteId }, 'monitor.tick_site_missing');
    return;
  }
  if (site.paused) {
    logger.trace({ siteId }, 'monitor.tick_paused');
    schedule(site, site.interval_seconds || 60);
    return;
  }
  if (site.monitor_type === 'heartbeat') {
    schedule(site, 60);
    return;
  }

  let result;
  try {
    result = await runCheck(site);
  } catch (err) {
    logger.error({ err, siteId }, 'monitor.tick_unexpected_error');
    result = {
      isUp: 0,
      statusCode: null,
      responseTimeMs: null,
      errorMessage: `unhandled: ${err.message}`,
      challenged: false,
    };
  }

  try {
    await processResult(site, result);
  } catch (err) {
    logger.error({ err, siteId }, 'monitor.process_failed');
  }

  const nextSec = computeNextDelaySeconds(site, result);
  schedule(site, nextSec);
}

function schedule(site, delaySeconds) {
  const s = getState(site.id);
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => tick(site.id).catch((err) => logger.error({ err, siteId: site.id }, 'monitor.tick_crash')), delaySeconds * 1000);
  if (s.timer.unref) s.timer.unref();
  logger.trace({ siteId: site.id, delaySeconds }, 'monitor.scheduled');
}

async function startSite(site) {
  const s = getState(site.id);
  s.stopping = false;
  s.consecutiveFailures = 0;
  s.consecutiveInconclusive = 0;
  s.cfStreakAlerted = false;
  s.currentInterval = null;
  s.lastResultIsUp = site.current_state === 'up' ? 1 : site.current_state === 'down' ? 0 : null;

  if (site.monitor_type === 'heartbeat') {
    logger.info({ siteId: site.id, name: site.name }, 'monitor.heartbeat_registered');
    schedule(site, 60);
    return;
  }

  const initialDelay = Math.floor(Math.random() * 5) + 1;
  schedule(site, initialDelay);
  logger.info({ siteId: site.id, name: site.name, initialDelay }, 'monitor.active_started');
}

function stopSite(siteId) {
  const s = state.get(siteId);
  if (!s) return;
  s.stopping = true;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  state.delete(siteId);
  logger.info({ siteId }, 'monitor.site_stopped');
}

async function reloadSite(siteId) {
  stopSite(siteId);
  const site = await loadSite(siteId);
  if (site) await startSite(site);
}

async function checkNow(siteId) {
  const site = await loadSite(siteId);
  if (!site) throw new Error('site not found');
  if (site.monitor_type === 'heartbeat') {
    const result = await evaluateHeartbeat(site);
    await processResult(site, result);
    return result;
  }
  const result = await runCheck(site);
  await processResult(site, result);
  return result;
}

async function recordHeartbeatPing(site) {
  await db.query(`UPDATE sites SET last_heartbeat_at = ${db.nowMs()} WHERE id = ?`, [site.id]);
  const refreshed = await loadSite(site.id);
  await processResult(refreshed, {
    isUp: 1,
    statusCode: null,
    responseTimeMs: null,
    errorMessage: null,
    challenged: false,
  });
}

async function watchdogTick() {
  try {
    const sites = await db.query(
      `SELECT * FROM sites WHERE monitor_type='heartbeat' AND paused=0`
    );
    for (const site of sites) {
      const result = await evaluateHeartbeat(site);
      const s = getState(site.id);
      const lastWasFailure = s.lastResultIsUp === 0;
      if (result.isUp === 0 && !lastWasFailure) {
        await processResult(site, result);
      } else if (result.isUp === 1 && s.lastResultIsUp === null) {
        s.lastResultIsUp = 1;
      }
    }
  } catch (err) {
    logger.error({ err }, 'monitor.watchdog_failed');
  }
}

async function start() {
  const sites = await db.query('SELECT * FROM sites');
  logger.info({ count: sites.length }, 'monitor.starting_all_sites');
  for (const site of sites) {
    await startSite(site);
  }
  setInterval(watchdogTick, WATCHDOG_INTERVAL_MS).unref();
}

module.exports = {
  start,
  startSite,
  stopSite,
  reloadSite,
  checkNow,
  recordHeartbeatPing,
};
