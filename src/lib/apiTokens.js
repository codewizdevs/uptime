'use strict';

const crypto = require('crypto');
const db = require('../db');

const TOKEN_PREFIX = 'utk_';
const VALID_SCOPES = ['read', 'write'];

function generateToken() {
  const raw = crypto.randomBytes(24).toString('hex'); // 48 chars
  return TOKEN_PREFIX + raw;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

async function listTokens({ userId } = {}) {
  if (userId === undefined) {
    return db.query(
      `SELECT id, name, scope, last_used_at, created_at, user_id
         FROM api_tokens ORDER BY id DESC`
    );
  }
  // userId may be null (env-admin tokens) or a number (specific DB user).
  return db.query(
    `SELECT id, name, scope, last_used_at, created_at, user_id
       FROM api_tokens
      WHERE ${userId === null ? 'user_id IS NULL' : 'user_id = ?'}
      ORDER BY id DESC`,
    userId === null ? [] : [userId]
  );
}

async function createToken(name, scope, userId = null) {
  const trimmed = String(name || '').trim().slice(0, 160);
  if (!trimmed) throw new Error('Token name is required');
  const s = VALID_SCOPES.includes(scope) ? scope : 'read';
  const token = generateToken();
  const result = await db.query(
    `INSERT INTO api_tokens (name, token_hash, scope, user_id)
     VALUES (?, ?, ?, ?)`,
    [trimmed, hashToken(token), s, userId]
  );
  return { id: result.insertId, name: trimmed, scope: s, token, user_id: userId };
}

async function deleteToken(id) {
  await db.query(`DELETE FROM api_tokens WHERE id = ?`, [id]);
}

async function findByToken(token) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
  const rows = await db.query(
    `SELECT id, name, scope, user_id FROM api_tokens WHERE token_hash = ? LIMIT 1`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row) return null;
  db.query(`UPDATE api_tokens SET last_used_at = ${db.nowMs()} WHERE id = ?`, [row.id])
    .catch(() => {});
  return row;
}

function extractToken(req) {
  const h = req.get('authorization') || req.get('Authorization') || '';
  const m = /^Bearer\s+(\S+)/.exec(h);
  if (m) return m[1];
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  return null;
}

module.exports = {
  TOKEN_PREFIX,
  VALID_SCOPES,
  generateToken,
  hashToken,
  listTokens,
  createToken,
  deleteToken,
  findByToken,
  extractToken,
};
