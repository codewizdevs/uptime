'use strict';

const channels = require('./lib/channels');
const { formatDuration } = require('./lib/format');

async function notifyDown(site, error) {
  await channels.notifySite(site, 'down', { error });
}

async function notifyRecovered(site, durationSeconds) {
  await channels.notifySite(site, 'recovered', { duration_seconds: durationSeconds });
}

async function notifyChallenged(site, streak) {
  await channels.notifySite(site, 'challenged', { streak });
}

module.exports = { notifyDown, notifyRecovered, notifyChallenged, formatDuration };
