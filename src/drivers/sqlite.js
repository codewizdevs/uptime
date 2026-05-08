'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../logger');

const DIALECT = 'sqlite';

const dbPath = config.db.sqlitePath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath, { fileMustExist: false });
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

logger.info({ driver: DIALECT, path: dbPath }, 'db.opened');

function isReadStatement(sql) {
  return /^\s*(?:WITH\b[\s\S]*?\s+)?SELECT\b|\s*PRAGMA\b|\s*EXPLAIN\b/i.test(sql);
}

async function query(sql, params = []) {
  const start = Date.now();
  try {
    if (isReadStatement(sql)) {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...params);
      if (config.appDebug) {
        logger.trace(
          { sql: sql.replace(/\s+/g, ' ').slice(0, 240), durationMs: Date.now() - start, rowsAffected: rows.length },
          'db.query'
        );
      }
      return rows;
    }
    const stmt = db.prepare(sql);
    const info = stmt.run(...params);
    const result = [];
    result.affectedRows = info.changes;
    result.insertId = Number(info.lastInsertRowid);
    result.changes = info.changes;
    if (config.appDebug) {
      logger.trace(
        { sql: sql.replace(/\s+/g, ' ').slice(0, 240), durationMs: Date.now() - start, rowsAffected: info.changes, insertId: result.insertId },
        'db.query'
      );
    }
    return result;
  } catch (err) {
    logger.error({ err, sql: sql.replace(/\s+/g, ' ').slice(0, 240) }, 'db.query failed');
    throw err;
  }
}

async function ensureSchema() {
  const ddl = fs.readFileSync(config.paths.schemaSqlite, 'utf8');
  db.exec(ddl);
  logger.info({ driver: DIALECT, path: dbPath }, 'schema ensured');
}

async function close() {
  db.close();
}

const helpers = {
  dialect: DIALECT,
  nowMs: () => "strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  diffSecondsSql: (a, b) => `CAST((julianday(${b}) - julianday(${a})) * 86400 AS INTEGER)`,
  castJson: () => '?',
  intervalAgoSql: () => `strftime('%Y-%m-%dT%H:%M:%fZ', CAST(strftime('%s','now') AS INTEGER) - (? * 3600), 'unixepoch')`,
  bucketTimeSql: (col) =>
    `strftime('%Y-%m-%dT%H:%M:%SZ', (CAST(strftime('%s', ${col}) AS INTEGER) / (? * 60)) * (? * 60), 'unixepoch')`,
  greatestSql: (...args) => `MAX(${args.join(', ')})`,
};

module.exports = { query, ensureSchema, close, raw: db, ...helpers };
