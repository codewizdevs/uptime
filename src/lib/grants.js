'use strict';

// Per-monitor grants CRUD. See src/lib/acl.js for the read side that enforces
// these on every request.

const db = require('../db');

const VALID_PERMISSIONS = ['view', 'manage'];

function validatePermission(p) {
  return VALID_PERMISSIONS.includes(p) ? p : 'view';
}

async function listForSite(siteId) {
  return db.query(
    `SELECT g.site_id, g.user_id, g.permission, g.granted_at, g.granted_by_user_id,
            u.username, u.role, u.display_name, u.disabled
       FROM site_grants g
       JOIN users u ON u.id = g.user_id
      WHERE g.site_id = ?
      ORDER BY u.username ASC`,
    [siteId]
  );
}

async function listForUser(userId) {
  return db.query(
    `SELECT g.site_id, g.user_id, g.permission, g.granted_at, g.granted_by_user_id,
            s.name AS site_name, s.monitor_type
       FROM site_grants g
       JOIN sites s ON s.id = g.site_id
      WHERE g.user_id = ?
      ORDER BY s.name ASC`,
    [userId]
  );
}

async function get(siteId, userId) {
  const rows = await db.query(
    `SELECT site_id, user_id, permission, granted_at, granted_by_user_id
       FROM site_grants WHERE site_id = ? AND user_id = ? LIMIT 1`,
    [siteId, userId]
  );
  return rows[0] || null;
}

async function set(siteId, userId, permission, grantedByUserId = null) {
  const perm = validatePermission(permission);
  const existing = await get(siteId, userId);
  if (existing) {
    if (existing.permission === perm) return { changed: false };
    await db.query(
      `UPDATE site_grants SET permission = ? WHERE site_id = ? AND user_id = ?`,
      [perm, siteId, userId]
    );
    return { changed: true, prev: existing.permission };
  }
  await db.query(
    `INSERT INTO site_grants (site_id, user_id, permission, granted_by_user_id)
     VALUES (?, ?, ?, ?)`,
    [siteId, userId, perm, grantedByUserId]
  );
  return { changed: true, prev: null };
}

async function revoke(siteId, userId) {
  const result = await db.query(
    `DELETE FROM site_grants WHERE site_id = ? AND user_id = ?`,
    [siteId, userId]
  );
  return (result.affectedRows ?? result.changes ?? 0) > 0;
}

// Bulk replace grants for a single user across many sites. `entries` is an
// array of { siteId, permission }. Sites missing from `entries` are revoked.
async function setManyForUser(userId, entries, grantedByUserId = null) {
  const incoming = new Map();
  for (const e of entries || []) {
    if (e && Number.isFinite(e.siteId)) {
      incoming.set(Number(e.siteId), validatePermission(e.permission));
    }
  }
  const existing = await db.query(
    `SELECT site_id, permission FROM site_grants WHERE user_id = ?`,
    [userId]
  );
  const existingMap = new Map(existing.map((r) => [Number(r.site_id), r.permission]));

  for (const [siteId, prev] of existingMap) {
    if (!incoming.has(siteId)) {
      await db.query(
        `DELETE FROM site_grants WHERE site_id = ? AND user_id = ?`,
        [siteId, userId]
      );
    }
  }
  for (const [siteId, perm] of incoming) {
    const prev = existingMap.get(siteId);
    if (!prev) {
      await db.query(
        `INSERT INTO site_grants (site_id, user_id, permission, granted_by_user_id)
         VALUES (?, ?, ?, ?)`,
        [siteId, userId, perm, grantedByUserId]
      );
    } else if (prev !== perm) {
      await db.query(
        `UPDATE site_grants SET permission = ? WHERE site_id = ? AND user_id = ?`,
        [perm, siteId, userId]
      );
    }
  }
}

async function revokeAllForUser(userId) {
  await db.query(`DELETE FROM site_grants WHERE user_id = ?`, [userId]);
}

module.exports = {
  VALID_PERMISSIONS,
  listForSite,
  listForUser,
  get,
  set,
  revoke,
  setManyForUser,
  revokeAllForUser,
};
