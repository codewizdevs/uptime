'use strict';

const db = require('../db');

async function uptimePct(siteId, hours) {
  const rows = await db.query(
    `SELECT
       SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) AS up_count,
       SUM(CASE WHEN is_up = 0 THEN 1 ELSE 0 END) AS down_count
     FROM checks
     WHERE site_id = ? AND checked_at > ${db.intervalAgoSql()} AND is_up IS NOT NULL`,
    [siteId, hours]
  );
  const r = rows[0] || {};
  const up = Number(r.up_count || 0);
  const down = Number(r.down_count || 0);
  const total = up + down;
  if (!total) return null;
  return (up / total) * 100;
}

async function responseTimeStats(siteId, hours) {
  const rows = await db.query(
    `SELECT response_time_ms FROM checks
     WHERE site_id = ? AND is_up = 1 AND response_time_ms IS NOT NULL
       AND checked_at > ${db.intervalAgoSql()}
     ORDER BY response_time_ms ASC`,
    [siteId, hours]
  );
  if (!rows.length) return null;
  const arr = rows.map((r) => r.response_time_ms);
  const sum = arr.reduce((a, b) => a + b, 0);
  const avg = sum / arr.length;
  const p = (q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
  return {
    count: arr.length,
    min: arr[0],
    max: arr[arr.length - 1],
    avg: Math.round(avg),
    p50: p(0.5),
    p95: p(0.95),
  };
}

async function recentChecks(siteId, limit = 50) {
  return db.query(
    `SELECT id, checked_at, is_up, status_code, response_time_ms, error_message
     FROM checks WHERE site_id = ? ORDER BY checked_at DESC LIMIT ?`,
    [siteId, limit]
  );
}

async function timeseries(siteId, hours, bucketMinutes = 5) {
  const rows = await db.query(
    `SELECT
       ${db.bucketTimeSql('checked_at')} AS bucket,
       AVG(response_time_ms) AS avg_ms,
       SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) AS up_count,
       SUM(CASE WHEN is_up = 0 THEN 1 ELSE 0 END) AS down_count,
       SUM(CASE WHEN is_up IS NULL THEN 1 ELSE 0 END) AS inconclusive_count
     FROM checks
     WHERE site_id = ? AND checked_at > ${db.intervalAgoSql()}
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [bucketMinutes, bucketMinutes, siteId, hours]
  );
  return rows.map((r) => ({
    bucket: r.bucket,
    avgMs: r.avg_ms == null ? null : Math.round(Number(r.avg_ms)),
    up: Number(r.up_count || 0),
    down: Number(r.down_count || 0),
    inconclusive: Number(r.inconclusive_count || 0),
  }));
}

async function recentIncidents(siteId, limit = 25) {
  return db.query(
    `SELECT id, started_at, ended_at, duration_seconds, last_error
     FROM incidents WHERE site_id = ?
     ORDER BY started_at DESC LIMIT ?`,
    [siteId, limit]
  );
}

async function totalDowntimeSeconds(siteId, hours) {
  const rows = await db.query(
    `SELECT COALESCE(SUM(
       CASE
         WHEN ended_at IS NULL THEN ${db.diffSecondsSql(db.greatestSql('started_at', db.intervalAgoSql()), db.nowMs())}
         ELSE ${db.diffSecondsSql(db.greatestSql('started_at', db.intervalAgoSql()), 'ended_at')}
       END
     ), 0) AS total_sec
     FROM incidents
     WHERE site_id = ? AND (ended_at IS NULL OR ended_at > ${db.intervalAgoSql()})`,
    [hours, hours, siteId, hours]
  );
  return Number(rows[0]?.total_sec || 0);
}

async function lastCheck(siteId) {
  const rows = await db.query(
    `SELECT checked_at, is_up, status_code, response_time_ms, error_message
     FROM checks WHERE site_id = ? ORDER BY checked_at DESC LIMIT 1`,
    [siteId]
  );
  return rows[0] || null;
}

module.exports = {
  uptimePct,
  responseTimeStats,
  recentChecks,
  recentIncidents,
  totalDowntimeSeconds,
  timeseries,
  lastCheck,
};
