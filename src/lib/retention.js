'use strict';

const db = require('../db');
const logger = require('../logger');
const config = require('../config');

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

async function pruneTable(table, column, days) {
  if (!days || days <= 0) return { table, deleted: 0, skipped: true };
  const cutoff = isoDaysAgo(days);
  const result = await db.query(`DELETE FROM ${table} WHERE ${column} < ?`, [cutoff]);
  const deleted = result.affectedRows ?? result.changes ?? 0;
  return { table, deleted, cutoff };
}

async function run({ vacuum = config.retention.vacuum } = {}) {
  const r = config.retention;
  const results = [];
  results.push(await pruneTable('checks',          'checked_at',  r.checksDays));
  // For incidents we prune only by ended_at — never delete an open incident.
  if (r.incidentsDays > 0) {
    const cutoff = isoDaysAgo(r.incidentsDays);
    const result = await db.query(
      `DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?`,
      [cutoff]
    );
    results.push({ table: 'incidents', deleted: result.affectedRows ?? result.changes ?? 0, cutoff });
  }
  results.push(await pruneTable('heartbeat_pings', 'received_at', r.heartbeatPingsDays));
  results.push(await pruneTable('audit_log',       'at',          r.auditDays));

  if (vacuum && db.dialect === 'sqlite') {
    try {
      await db.query(`VACUUM`);
      results.push({ table: 'sqlite_vacuum', deleted: 0, vacuumed: true });
    } catch (err) {
      logger.warn({ err }, 'retention.vacuum_failed');
    }
  }

  logger.info({ results }, 'retention.completed');
  return results;
}

function schedule() {
  const intervalH = Math.max(1, config.retention.runIntervalHours);
  const intervalMs = intervalH * 3600_000;
  logger.info({ intervalHours: intervalH, ...config.retention }, 'retention.scheduled');
  // Run once on startup, then every interval.
  setTimeout(() => {
    run().catch((err) => logger.error({ err }, 'retention.initial_failed'));
  }, 30 * 1000); // wait 30s after boot to avoid competing with migrations
  setInterval(() => {
    run().catch((err) => logger.error({ err }, 'retention.scheduled_failed'));
  }, intervalMs).unref();
}

module.exports = { run, schedule };
