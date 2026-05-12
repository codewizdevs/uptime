'use strict';

const channels = require('./lib/channels');
const maintenance = require('./lib/maintenance');
const logger = require('./logger');
const { formatDuration } = require('./lib/format');

// Wrap channels.notifySite with a maintenance-window check. Any active
// window with suppress_notifications=1 causes the dispatch to be skipped
// entirely (still logged for audit-trail purposes).
async function fire(site, event, payload) {
  // Per-monitor mute is an explicit user toggle: probe still runs, but no
  // alerts fire. Distinct from maintenance windows and from pausing.
  if (site.mute_notifications) {
    logger.info({ siteId: site.id, event }, 'notifier.suppressed_by_mute');
    return;
  }
  try {
    const suppressing = await maintenance.isAlertSuppressed(site.id);
    if (suppressing) {
      logger.info(
        { siteId: site.id, event, windowId: suppressing.id, windowName: suppressing.name },
        'notifier.suppressed_by_maintenance'
      );
      return;
    }
  } catch (err) {
    logger.warn({ err, siteId: site.id }, 'notifier.maintenance_lookup_failed');
  }
  await channels.notifySite(site, event, payload);
}

async function notifyDown(site, error) {
  await fire(site, 'down', { error });
}

async function notifyRecovered(site, durationSeconds) {
  await fire(site, 'recovered', { duration_seconds: durationSeconds });
}

async function notifyChallenged(site, streak) {
  await fire(site, 'challenged', { streak });
}

async function notifyCertExpiring(site, certInfo) {
  await fire(site, 'cert_expiring', {
    cert_days_remaining: certInfo.days_remaining,
    cert_subject: certInfo.subject,
    cert_issuer: certInfo.issuer,
    cert_valid_to: certInfo.valid_to,
  });
}

module.exports = { notifyDown, notifyRecovered, notifyChallenged, notifyCertExpiring, formatDuration };
