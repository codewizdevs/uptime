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

async function query(sql, params = []) {
  const start = Date.now();
  try {
    const [rows] = await pool.query(sql, params);
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
