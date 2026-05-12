'use strict';

// DB-backed users for Phase 14 (multi-user + per-monitor ACLs).
//
// The env super-admin is NEVER stored here — it lives entirely in .env and is
// authenticated by direct comparison in src/auth.js. It is treated as a
// synthetic admin user with id = null, isEnv = true. Creating a DB user with
// the same username is refused so the env path can never be shadowed.

const crypto = require('crypto');
const argon2 = require('argon2');
const db = require('../db');
const config = require('../config');
const logger = require('../logger');

const ROLES = ['admin', 'editor', 'viewer'];
const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 };

// Argon2id params — modest defaults that complete in <100ms on a vps-tier
// CPU. Tunable if a deployment has more headroom.
const ARGON_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

function normalizeUsername(raw) {
  return String(raw || '').trim().toLowerCase();
}

function isReservedUsername(name) {
  const cmp = normalizeUsername(name);
  const reserved = normalizeUsername(config.admin.user);
  return !!cmp && cmp === reserved;
}

function validateRole(role) {
  return ROLES.includes(role) ? role : 'viewer';
}

function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    email: r.email || null,
    display_name: r.display_name || null,
    disabled: !!r.disabled,
    must_change_password: !!r.must_change_password,
    totp_enabled: !!r.totp_enabled,
    totp_secret: r.totp_secret || null,
    totp_recovery_codes: r.totp_recovery_codes || null,
    last_login_at: r.last_login_at || null,
    last_login_ip: r.last_login_ip || null,
    password_changed_at: r.password_changed_at || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by_user_id: r.created_by_user_id || null,
  };
}

async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  return argon2.hash(plain, ARGON_OPTS);
}

async function verifyPassword(hash, plain) {
  if (!hash || typeof plain !== 'string') return false;
  try {
    return await argon2.verify(hash, plain);
  } catch (err) {
    logger.warn({ err: err.message }, 'users.verify_password_failed');
    return false;
  }
}

function generateInitialPassword() {
  // 12 chars, base64-url without padding. Memorable enough to read once.
  return crypto.randomBytes(9).toString('base64')
    .replace(/\+/g, 'A').replace(/\//g, 'B').replace(/=/g, '');
}

async function findByUsername(rawUsername) {
  const username = normalizeUsername(rawUsername);
  if (!username) return null;
  const rows = await db.query(
    `SELECT id, username, password_hash, role, email, display_name,
            totp_secret, totp_enabled, totp_recovery_codes,
            disabled, must_change_password,
            last_login_at, last_login_ip,
            password_changed_at, created_at, updated_at, created_by_user_id
       FROM users WHERE username = ? LIMIT 1`,
    [username]
  );
  const r = rows[0];
  if (!r) return null;
  const user = rowToUser(r);
  user.password_hash = r.password_hash;
  return user;
}

async function getById(id) {
  if (id == null) return null;
  const rows = await db.query(
    `SELECT id, username, password_hash, role, email, display_name,
            totp_secret, totp_enabled, totp_recovery_codes,
            disabled, must_change_password,
            last_login_at, last_login_ip,
            password_changed_at, created_at, updated_at, created_by_user_id
       FROM users WHERE id = ? LIMIT 1`,
    [id]
  );
  return rowToUser(rows[0] || null);
}

async function list() {
  const rows = await db.query(
    `SELECT id, username, role, email, display_name, disabled,
            must_change_password, totp_enabled,
            last_login_at, last_login_ip, created_at, updated_at,
            created_by_user_id
       FROM users ORDER BY username ASC`
  );
  return rows.map(rowToUser);
}

async function countActive() {
  const rows = await db.query(`SELECT COUNT(*) AS c FROM users WHERE disabled = 0`);
  return Number(rows[0]?.c || 0);
}

async function countAdmins() {
  const rows = await db.query(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0`);
  return Number(rows[0]?.c || 0);
}

async function create({ username, password, role, email = null, displayName = null, mustChangePassword = false, createdByUserId = null }) {
  const uname = normalizeUsername(username);
  if (!uname || !/^[a-z0-9_.-]{2,64}$/.test(uname)) {
    throw new Error('Username must be 2-64 chars, lowercase letters/digits/._-');
  }
  if (isReservedUsername(uname)) {
    throw new Error(`Username "${uname}" is reserved for the env super-admin`);
  }
  const existing = await findByUsername(uname);
  if (existing) throw new Error(`User "${uname}" already exists`);
  const r = validateRole(role);
  const hash = await hashPassword(password);
  const result = await db.query(
    `INSERT INTO users (username, password_hash, role, email, display_name,
                        must_change_password, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      uname, hash, r,
      email ? String(email).trim().slice(0, 255) : null,
      displayName ? String(displayName).trim().slice(0, 120) : null,
      mustChangePassword ? 1 : 0,
      createdByUserId,
    ]
  );
  return getById(result.insertId);
}

async function updateRole(id, role) {
  const r = validateRole(role);
  await db.query(`UPDATE users SET role = ?, updated_at = ${db.nowMs()} WHERE id = ?`, [r, id]);
}

async function setDisabled(id, disabled) {
  await db.query(
    `UPDATE users SET disabled = ?, updated_at = ${db.nowMs()} WHERE id = ?`,
    [disabled ? 1 : 0, id]
  );
}

async function setPassword(id, plain, { mustChange = false } = {}) {
  const hash = await hashPassword(plain);
  await db.query(
    `UPDATE users SET password_hash = ?, must_change_password = ?,
                      password_changed_at = ${db.nowMs()},
                      updated_at = ${db.nowMs()}
       WHERE id = ?`,
    [hash, mustChange ? 1 : 0, id]
  );
}

async function setMustChangePassword(id, must) {
  await db.query(
    `UPDATE users SET must_change_password = ?, updated_at = ${db.nowMs()} WHERE id = ?`,
    [must ? 1 : 0, id]
  );
}

async function setProfile(id, { email, displayName }) {
  await db.query(
    `UPDATE users SET email = ?, display_name = ?, updated_at = ${db.nowMs()} WHERE id = ?`,
    [
      email != null ? String(email).trim().slice(0, 255) || null : null,
      displayName != null ? String(displayName).trim().slice(0, 120) || null : null,
      id,
    ]
  );
}

async function setTotp(id, { secret, enabled, recoveryCodes }) {
  await db.query(
    `UPDATE users SET totp_secret = ?, totp_enabled = ?, totp_recovery_codes = ?,
                      updated_at = ${db.nowMs()}
       WHERE id = ?`,
    [
      secret || null,
      enabled ? 1 : 0,
      recoveryCodes ? JSON.stringify(recoveryCodes) : null,
      id,
    ]
  );
}

async function recordLogin(id, ip) {
  await db.query(
    `UPDATE users SET last_login_at = ${db.nowMs()}, last_login_ip = ?,
                      updated_at = ${db.nowMs()}
       WHERE id = ?`,
    [(ip || '').toString().slice(0, 64) || null, id]
  );
}

async function deleteUser(id) {
  // Site grants cascade via app code (no FK on SQLite for simplicity).
  await db.query(`DELETE FROM site_grants WHERE user_id = ?`, [id]);
  await db.query(`DELETE FROM api_tokens WHERE user_id = ?`, [id]);
  // Sites owned by this user become unowned (admin-only visibility).
  await db.query(`UPDATE sites SET owner_user_id = NULL WHERE owner_user_id = ?`, [id]);
  await db.query(`DELETE FROM users WHERE id = ?`, [id]);
}

async function claimUnownedSites(userId) {
  const result = await db.query(
    `UPDATE sites SET owner_user_id = ? WHERE owner_user_id IS NULL`,
    [userId]
  );
  return result.affectedRows ?? result.changes ?? 0;
}

// Synthetic "user" object representing the env super-admin. Used wherever an
// acting user is required but the request came from the .env account.
function envAdminUser() {
  return {
    id: null,
    isEnv: true,
    username: config.admin.user,
    role: 'admin',
    disabled: false,
    must_change_password: false,
  };
}

module.exports = {
  ROLES,
  ROLE_RANK,
  isReservedUsername,
  validateRole,
  hashPassword,
  verifyPassword,
  generateInitialPassword,
  findByUsername,
  getById,
  list,
  countActive,
  countAdmins,
  create,
  updateRole,
  setDisabled,
  setPassword,
  setMustChangePassword,
  setProfile,
  setTotp,
  recordLogin,
  deleteUser,
  claimUnownedSites,
  envAdminUser,
};
