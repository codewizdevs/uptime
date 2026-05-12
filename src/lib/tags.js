'use strict';

const db = require('../db');
const logger = require('../logger');

// Allowed Tabler colour names — kept short so badge-bg-* classes are valid.
const COLOR_PALETTE = [
  'secondary', 'primary', 'red', 'orange', 'yellow', 'green',
  'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink',
];

function normalizeColor(c) {
  const v = String(c || 'secondary').toLowerCase();
  return COLOR_PALETTE.includes(v) ? v : 'secondary';
}

function normalizeName(n) {
  return String(n || '').trim().slice(0, 64);
}

async function listTags() {
  return db.query(`
    SELECT t.id, t.name, t.color,
           COALESCE(c.cnt, 0) AS site_count
      FROM tags t
      LEFT JOIN (
        SELECT tag_id, COUNT(*) AS cnt FROM site_tags GROUP BY tag_id
      ) c ON c.tag_id = t.id
     ORDER BY t.name ASC
  `);
}

async function getTag(id) {
  const rows = await db.query(`SELECT * FROM tags WHERE id = ?`, [id]);
  return rows[0] || null;
}

async function createTag(name, color) {
  const n = normalizeName(name);
  if (!n) throw new Error('tag name required');
  const c = normalizeColor(color);
  const result = await db.query(
    `INSERT INTO tags (name, color) VALUES (?, ?)`,
    [n, c]
  );
  return result.insertId;
}

async function updateTag(id, name, color) {
  const n = normalizeName(name);
  if (!n) throw new Error('tag name required');
  const c = normalizeColor(color);
  await db.query(`UPDATE tags SET name=?, color=? WHERE id=?`, [n, c, id]);
}

async function deleteTag(id) {
  await db.query(`DELETE FROM site_tags WHERE tag_id = ?`, [id]);
  await db.query(`DELETE FROM tags WHERE id = ?`, [id]);
}

async function listSiteTags(siteId) {
  return db.query(
    `SELECT t.id, t.name, t.color
       FROM site_tags st
       JOIN tags t ON t.id = st.tag_id
      WHERE st.site_id = ?
      ORDER BY t.name ASC`,
    [siteId]
  );
}

// Bulk-load tags for many sites. Returns Map<siteId, [{id, name, color}]>.
async function tagsForSites(siteIds) {
  const out = new Map();
  if (!siteIds || !siteIds.length) return out;
  const placeholders = siteIds.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT st.site_id, t.id, t.name, t.color
       FROM site_tags st
       JOIN tags t ON t.id = st.tag_id
      WHERE st.site_id IN (${placeholders})
      ORDER BY t.name ASC`,
    siteIds
  );
  for (const r of rows) {
    if (!out.has(r.site_id)) out.set(r.site_id, []);
    out.get(r.site_id).push({ id: r.id, name: r.name, color: r.color });
  }
  return out;
}

async function setSiteTags(siteId, tagIds) {
  const clean = (tagIds || [])
    .map((v) => parseInt(v, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  await db.query(`DELETE FROM site_tags WHERE site_id = ?`, [siteId]);
  for (const tagId of clean) {
    try {
      await db.query(`INSERT INTO site_tags (site_id, tag_id) VALUES (?, ?)`, [siteId, tagId]);
    } catch (err) {
      logger.warn({ err, siteId, tagId }, 'tags.set_failed');
    }
  }
}

async function attachToSites(siteIds, tagId) {
  for (const sid of siteIds) {
    try {
      await db.query(
        `INSERT INTO site_tags (site_id, tag_id) VALUES (?, ?)`,
        [sid, tagId]
      );
    } catch { /* dup primary-key on re-tag is fine */ }
  }
}

async function detachFromSites(siteIds, tagId) {
  if (!siteIds.length) return;
  const placeholders = siteIds.map(() => '?').join(',');
  await db.query(
    `DELETE FROM site_tags WHERE tag_id = ? AND site_id IN (${placeholders})`,
    [tagId, ...siteIds]
  );
}

module.exports = {
  COLOR_PALETTE,
  normalizeColor,
  listTags,
  getTag,
  createTag,
  updateTag,
  deleteTag,
  listSiteTags,
  tagsForSites,
  setSiteTags,
  attachToSites,
  detachFromSites,
};
