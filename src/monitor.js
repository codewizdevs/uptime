'use strict';

const db = require('./db');
const logger = require('./logger');
const { runCheck, evaluateHeartbeat } = require('./lib/checker');
const cf = require('./lib/cloudflare');
const notifier = require('./notifier');
const maintenance = require('./lib/maintenance');

const HEARTBEAT_PINGS_KEEP_PER_SITE = 50;
const HEARTBEAT_BODY_MAX_BYTES = 4096;

function truncateBody(buf) {
  if (!buf) return null;
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (!s) return null;
  if (s.length <= HEARTBEAT_BODY_MAX_BYTES) return s;
  return s.slice(0, HEARTBEAT_BODY_MAX_BYTES) + `\n…(truncated, ${s.length - HEARTBEAT_BODY_MAX_BYTES} more bytes)`;
}

async function pruneHeartbeatPings(siteId) {
  // Keep the latest N rows per site, drop the rest.
  if (db.dialect === 'sqlite') {
    await db.query(
      `DELETE FROM heartbeat_pings
        WHERE site_id = ? AND id NOT IN (
          SELECT id FROM heartbeat_pings WHERE site_id = ? ORDER BY id DESC LIMIT ${HEARTBEAT_PINGS_KEEP_PER_SITE}
        )`,
      [siteId, siteId]
    );
  } else {
    await db.query(
      `DELETE p FROM heartbeat_pings p
         JOIN (
           SELECT id FROM heartbeat_pings
            WHERE site_id = ?
            ORDER BY id DESC
            LIMIT ?, 1000000
         ) keep ON keep.id = p.id`,
      [siteId, HEARTBEAT_PINGS_KEEP_PER_SITE]
    );
  }
}

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
  // Tag incidents that begin inside a maintenance window so they can be
  // filtered out of MTBF / availability charts later.
  let duringMaintenance = 0;
  try {
    const w = await maintenance.isActive(site.id);
    if (w) duringMaintenance = 1;
  } catch { /* don't block the incident on a lookup failure */ }
  await db.query(
    `INSERT INTO incidents (site_id, last_error, during_maintenance) VALUES (?, ?, ?)`,
    [site.id, error || null, duringMaintenance]
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

async function persistCertInfo(site, certData) {
  if (!certData) return;
  await db.query(
    `UPDATE sites
        SET last_cert_subject = ?,
            last_cert_issuer = ?,
            last_cert_valid_to = ?,
            last_cert_days_remaining = ?,
            last_cert_checked_at = ${db.nowMs()}
      WHERE id = ?`,
    [
      certData.subject || null,
      certData.issuer || null,
      certData.valid_to || null,
      certData.days_remaining == null ? null : certData.days_remaining,
      site.id,
    ]
  );
}

// Decide whether to fire a cert_expiring alert. We only fire once per
// (monitor, threshold-band) so we don't spam. Bands:
//   - >warn_days       → never alerted, alerted_at_days = null
//   - <=warn_days      → first crossing fires once; subsequent ticks suppress
//                        unless cert changed (new issuer/subject) or
//                        days_remaining shrank by a meaningful step (7d/3d/1d/0d)
function shouldAlertCertExpiry(site, certData) {
  if (!certData || certData.days_remaining == null) return false;
  const warnDays = site.cert_expiry_warn_days == null ? 14 : Number(site.cert_expiry_warn_days);
  const days = Number(certData.days_remaining);
  if (warnDays <= 0) return false;
  if (days > warnDays) return false;
  const lastAlertedDays = site.cert_expiry_alerted_at_days == null
    ? null
    : Number(site.cert_expiry_alerted_at_days);
  if (lastAlertedDays == null) return true;
  // Re-alert when crossing one of these stricter bands.
  const bands = [warnDays, 7, 3, 1, 0];
  for (const band of bands) {
    if (band <= warnDays && days <= band && lastAlertedDays > band) return true;
  }
  return false;
}

async function markCertAlerted(site, days) {
  await db.query(
    `UPDATE sites SET cert_expiry_alerted_at = ${db.nowMs()}, cert_expiry_alerted_at_days = ? WHERE id = ?`,
    [days, site.id]
  );
}

async function persistDomainInfo(site, domainInfo) {
  if (!domainInfo) return;
  await db.query(
    `UPDATE sites
        SET domain_expires_at        = ?,
            domain_registrar         = ?,
            domain_status            = ?,
            domain_last_checked_at   = ${db.nowMs()}
      WHERE id = ?`,
    [
      domainInfo.expires_at || null,
      domainInfo.registrar || null,
      domainInfo.status || null,
      site.id,
    ]
  );
}

// Same band logic as cert expiry — fire once at first crossing of warn_days,
// re-alert on each crossing of {warn_days, 30, 14, 7, 3, 1, 0}-day boundaries.
function shouldAlertDomainExpiry(site, domainInfo) {
  if (!domainInfo || domainInfo.days_remaining == null) return false;
  const warnDays = site.domain_expiry_warn_days == null ? 30 : Number(site.domain_expiry_warn_days);
  const days = Number(domainInfo.days_remaining);
  if (warnDays <= 0) return false;
  if (days > warnDays) return false;
  const lastAlertedDays = site.domain_alerted_at_days == null ? null : Number(site.domain_alerted_at_days);
  if (lastAlertedDays == null) return true;
  const bands = [warnDays, 30, 14, 7, 3, 1, 0];
  for (const band of bands) {
    if (band <= warnDays && days <= band && lastAlertedDays > band) return true;
  }
  return false;
}

async function markDomainAlerted(site, days) {
  await db.query(
    `UPDATE sites SET domain_alerted_at_days = ? WHERE id = ?`,
    [days, site.id]
  );
}

async function processResult(site, result) {
  const s = getState(site.id);

  await recordCheck(site, result);

  // Cert side-channel — only saved on successful HTTPS probes or cert-type
  // monitors. Failures intentionally don't overwrite stale-but-correct data.
  if (result.cert) {
    await persistCertInfo(site, result.cert);
    if (shouldAlertCertExpiry(site, result.cert)) {
      logger.warn({ siteId: site.id, days: result.cert.days_remaining }, 'monitor.cert_expiring_alert');
      await notifier.notifyCertExpiring(site, result.cert);
      await markCertAlerted(site, result.cert.days_remaining);
    }
  }

  // Domain side-channel — only for monitor_type=domain. Same alert-band
  // semantics as cert: fire once per crossing, never spam.
  if (result.domain) {
    await persistDomainInfo(site, result.domain);
    if (shouldAlertDomainExpiry(site, result.domain)) {
      logger.warn({ siteId: site.id, days: result.domain.days_remaining }, 'monitor.domain_expiring_alert');
      await notifier.notifyDomainExpiring(site, result.domain);
      await markDomainAlerted(site, result.domain.days_remaining);
    }
  }

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
  // Maintenance window can request that we skip probing entirely (rare —
  // usually we still probe so the charts are continuous).
  try {
    const probeSuppress = await maintenance.isProbeSuppressed(siteId);
    if (probeSuppress) {
      logger.trace({ siteId, windowId: probeSuppress.id }, 'monitor.tick_in_maintenance_skip');
      schedule(site, site.interval_seconds || 60);
      return;
    }
  } catch (err) {
    logger.warn({ err, siteId }, 'monitor.maintenance_lookup_failed');
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

async function recordHeartbeatPing(site, info = {}) {
  // info shape: { kind: 'start'|'success'|'failure', exitCode?, body?, sourceIp?, userAgent? }
  const kind = ['start', 'success', 'failure'].includes(info.kind) ? info.kind : 'success';
  const exitCode = Number.isFinite(info.exitCode) ? info.exitCode : null;
  const bodySnippet = truncateBody(info.body);
  const sourceIp = (info.sourceIp || '').slice(0, 64) || null;
  const userAgent = (info.userAgent || '').slice(0, 255) || null;

  // Compute duration if this is a closing signal (success/failure) and the
  // previous ping for this site was a 'start'.
  let durationMs = null;
  if (kind !== 'start') {
    const cur = await db.query(
      `SELECT last_heartbeat_start_at FROM sites WHERE id = ? LIMIT 1`,
      [site.id]
    );
    const startAt = cur[0]?.last_heartbeat_start_at;
    if (startAt) {
      const s = new Date(startAt).getTime();
      if (Number.isFinite(s)) {
        durationMs = Math.max(0, Date.now() - s);
      }
    }
  }

  await db.query(
    `INSERT INTO heartbeat_pings
       (site_id, kind, exit_code, duration_ms, body, source_ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [site.id, kind, exitCode, durationMs, bodySnippet, sourceIp, userAgent]
  );
  await pruneHeartbeatPings(site.id);

  if (kind === 'start') {
    await db.query(
      `UPDATE sites
          SET last_heartbeat_start_at = ${db.nowMs()},
              last_heartbeat_kind = 'start'
        WHERE id = ?`,
      [site.id]
    );
    // 'start' is informational only — don't change current_state or fire alerts.
    return;
  }

  // 'success' or 'failure' is the terminal signal.
  await db.query(
    `UPDATE sites
        SET last_heartbeat_at = ${db.nowMs()},
            last_heartbeat_kind = ?,
            last_heartbeat_exit_code = ?,
            last_heartbeat_duration_ms = ?,
            last_heartbeat_body = ?,
            last_heartbeat_start_at = NULL
      WHERE id = ?`,
    [kind, exitCode, durationMs, bodySnippet, site.id]
  );

  const refreshed = await loadSite(site.id);
  const isUp = kind === 'success' ? 1 : 0;
  const errorMessage = kind === 'failure'
    ? `heartbeat reported failure${exitCode != null ? ` (exit ${exitCode})` : ''}`
    : null;
  await processResult(refreshed, {
    isUp,
    statusCode: null,
    responseTimeMs: durationMs,
    errorMessage,
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
