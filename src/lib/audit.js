'use strict';

const db = require('../db');
const logger = require('../logger');

function record(opts = {}) {
  const action = String(opts.action || '').slice(0, 64);
  if (!action) return Promise.resolve();
  let metaText = null;
  if (opts.meta != null) {
    try { metaText = JSON.stringify(opts.meta).slice(0, 4096); }
    catch { metaText = null; }
  }
  return db.query(
    `INSERT INTO audit_log (actor, actor_user_id, ip, action, target_type, target_id, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      (opts.actor || '').toString().slice(0, 64) || null,
      opts.actorUserId != null ? opts.actorUserId : null,
      (opts.ip || '').toString().slice(0, 64) || null,
      action,
      (opts.targetType || '').toString().slice(0, 32) || null,
      opts.targetId != null ? String(opts.targetId).slice(0, 32) : null,
      metaText,
    ]
  ).catch((err) => {
    logger.warn({ err, action }, 'audit.write_failed');
  });
}

function fromReq(req, action, opts = {}) {
  const u = req?.session?.user;
  return record({
    actor: u?.username || opts.actor || null,
    // Env admin has no user row, so actor_user_id stays NULL — readers
    // distinguish via `actor` text containing the env admin username.
    actorUserId: u && !u.isEnv ? u.id : null,
    ip: req?.ip || null,
    action,
    targetType: opts.targetType,
    targetId: opts.targetId,
    meta: opts.meta,
  });
}

async function list({ limit = 100, action = null, actorUserId = null } = {}) {
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const where = [];
  const params = [];
  if (action) { where.push('action = ?'); params.push(String(action).slice(0, 64)); }
  if (actorUserId != null) { where.push('actor_user_id = ?'); params.push(actorUserId); }
  const sql = `SELECT id, at, actor, actor_user_id, ip, action, target_type, target_id, meta
                 FROM audit_log
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY id DESC LIMIT ${lim}`;
  return db.query(sql, params);
}

async function listActions({ actorUserId = null } = {}) {
  if (actorUserId != null) {
    return db.query(
      `SELECT action, COUNT(*) AS c FROM audit_log WHERE actor_user_id = ?
        GROUP BY action ORDER BY action ASC`,
      [actorUserId]
    );
  }
  return db.query(
    `SELECT action, COUNT(*) AS c FROM audit_log GROUP BY action ORDER BY action ASC`
  );
}

module.exports = { record, fromReq, list, listActions };
