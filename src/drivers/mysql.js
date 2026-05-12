'use strict';

const fs = require('fs');
const mysql = require('mysql2/promise');
const config = require('../config');
const logger = require('../logger');

const DIALECT = 'mysql';

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: true,
  dateStrings: false,
  timezone: 'Z',
});

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'", (err) => {
    if (err) logger.warn({ err }, 'db.set_time_zone_failed');
  });
});

// ISO 8601 with T/Z separators (what Date#toISOString produces) is not a
// legal MySQL DATETIME literal. SQLite stores it verbatim, MySQL rejects it
// with ER_TRUNCATED_WRONG_VALUE. Normalize any param that LOOKS like a full
// ISO 8601 datetime so the rest of the codebase can keep producing
// `2026-06-26T06:16:55.000Z` style strings without driver-specific branches.
// Pattern is narrow enough not to false-positive on free-text columns.
const ISO_DT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
function normalizeParam(v) {
  if (typeof v !== 'string' || v.length < 20 || v.length > 35) return v;
  const m = ISO_DT.exec(v);
  if (!m) return v;
  // Convert to UTC then emit `YYYY-MM-DD HH:MM:SS.mmm`. We always store UTC
  // because the pool sets `time_zone = +00:00` on every connection.
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
       + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds())
       + '.' + pad(d.getUTCMilliseconds(), 3);
}
function normalizeParams(params) {
  if (!Array.isArray(params)) return params;
  let changed = false;
  const out = new Array(params.length);
  for (let i = 0; i < params.length; i++) {
    const v = normalizeParam(params[i]);
    if (v !== params[i]) changed = true;
    out[i] = v;
  }
  return changed ? out : params;
}

async function query(sql, params = []) {
  const start = Date.now();
  const safeParams = normalizeParams(params);
  try {
    const [rows] = await pool.query(sql, safeParams);
    if (config.appDebug) {
      logger.trace(
        { sql: sql.replace(/\s+/g, ' ').slice(0, 240), durationMs: Date.now() - start, rowsAffected: rows.affectedRows ?? rows.length },
        'db.query'
      );
    }
    return rows;
  } catch (err) {
    logger.error({ err, sql: sql.replace(/\s+/g, ' ').slice(0, 240) }, 'db.query failed');
    throw err;
  }
}

async function ensureSchema() {
  const ddl = fs.readFileSync(config.paths.schemaMysql, 'utf8');
  const conn = await pool.getConnection();
  try {
    await conn.query(ddl);
    logger.info({ driver: DIALECT }, 'schema ensured');
  } finally {
    conn.release();
  }
}

async function close() {
  await pool.end();
}

const helpers = {
  dialect: DIALECT,
  nowMs: () => 'CURRENT_TIMESTAMP(3)',
  diffSecondsSql: (a, b) => `TIMESTAMPDIFF(SECOND, ${a}, ${b})`,
  castJson: () => 'CAST(? AS JSON)',
  intervalAgoSql: () => `(NOW() - INTERVAL ? HOUR)`,
  bucketTimeSql: (col) =>
    `DATE_FORMAT(FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(${col}) / (? * 60)) * (? * 60)), '%Y-%m-%dT%H:%i:%sZ')`,
  greatestSql: (...args) => `GREATEST(${args.join(', ')})`,
};

module.exports = { query, ensureSchema, close, pool, ...helpers };
