'use strict';

// Per-monitor ACL helpers.
//
// "user" is always a session-shaped object: { id, username, role, isEnv }.
// Env super-admin has id === null and isEnv === true; we always treat it as
// admin so it can never lock itself out.

const db = require('../db');
const { parseId } = require('./ids');

function isAdmin(user) {
  if (!user) return false;
  if (user.isEnv) return true;
  return user.role === 'admin';
}

function isEditor(user) {
  return !!user && (isAdmin(user) || user.role === 'editor');
}

function isViewer(user) {
  return !!user && (isAdmin(user) || user.role === 'editor' || user.role === 'viewer');
}

async function canSeeSite(user, site) {
  if (!user || !site) return false;
  if (isAdmin(user)) return true;
  if (site.owner_user_id != null && site.owner_user_id === user.id) return true;
  // Anonymous (env-admin already returned true above, so user.id is set).
  const rows = await db.query(
    `SELECT permission FROM site_grants WHERE site_id = ? AND user_id = ? LIMIT 1`,
    [site.id, user.id]
  );
  return rows.length > 0;
}

async function canManageSite(user, site) {
  if (!user || !site) return false;
  if (isAdmin(user)) return true;
  // Viewers never manage, even when granted view.
  if (user.role === 'viewer') return false;
  if (site.owner_user_id != null && site.owner_user_id === user.id) return true;
  const rows = await db.query(
    `SELECT permission FROM site_grants WHERE site_id = ? AND user_id = ? LIMIT 1`,
    [site.id, user.id]
  );
  return rows.length > 0 && rows[0].permission === 'manage';
}

// Returns a SQL fragment + params that can be spliced into any sites query
// (WHERE clause). Admins get an always-true clause; everyone else gets a
// (owner = me OR id IN granted) filter. Caller is responsible for splicing
// it in with the right AND/WHERE glue.
function siteFilterClause(user, { table = 'sites' } = {}) {
  if (isAdmin(user)) {
    return { sql: '1 = 1', params: [] };
  }
  const userId = user?.id || -1;
  return {
    sql: `(${table}.owner_user_id = ? OR ${table}.id IN (SELECT site_id FROM site_grants WHERE user_id = ?))`,
    params: [userId, userId],
  };
}

async function siteVisibleIds(user) {
  if (isAdmin(user)) {
    const rows = await db.query(`SELECT id FROM sites`);
    return rows.map((r) => r.id);
  }
  if (!user || user.id == null) return [];
  const rows = await db.query(
    `SELECT id FROM sites WHERE owner_user_id = ?
        UNION
       SELECT site_id AS id FROM site_grants WHERE user_id = ?`,
    [user.id, user.id]
  );
  return rows.map((r) => r.id);
}

// Express middleware: load `req.params.id` as a site, enforce read access,
// and attach the row to `req.site`. Renders the standard 404 for "site
// doesn't exist" and 403 for "you can't see this one".
function requireSiteSee(req, res, next) {
  return loadAndCheck(req, res, next, 'see');
}

function requireSiteManage(req, res, next) {
  return loadAndCheck(req, res, next, 'manage');
}

async function loadAndCheck(req, res, next, mode) {
  try {
    const id = parseId(req.params.id);
    if (id == null) return notFound(req, res);
    const rows = await db.query(
      `SELECT * FROM sites WHERE id = ? LIMIT 1`,
      [id]
    );
    const site = rows[0];
    if (!site) return notFound(req, res);
    const ok = mode === 'manage'
      ? await canManageSite(req.session?.user, site)
      : await canSeeSite(req.session?.user, site);
    if (!ok) return forbidden(req, res);
    req.site = site;
    next();
  } catch (err) {
    next(err);
  }
}

function notFound(req, res) {
  if (wantsJson(req)) return res.status(404).json({ error: 'not found' });
  return res.status(404).render('error', { title: 'Not found', error: 'Monitor not found' });
}

function forbidden(req, res) {
  if (wantsJson(req)) return res.status(403).json({ error: 'forbidden' });
  return res.status(403).render('error', { title: 'Forbidden', error: 'You do not have permission to view this monitor.' });
}

function wantsJson(req) {
  if (req.path.startsWith('/api/')) return true;
  const accept = String(req.get('Accept') || '');
  return /application\/json/i.test(accept) && !/text\/html/i.test(accept);
}

// Generic role guard for non-site-scoped routes.
function requireRole(...allowed) {
  return (req, res, next) => {
    const user = req.session?.user;
    if (!user) return res.redirect('/login');
    if (allowed.includes(user.role) || isAdmin(user)) return next();
    if (wantsJson(req)) return res.status(403).json({ error: 'forbidden' });
    return res.status(403).render('error', { title: 'Forbidden', error: 'You do not have permission to access this page.' });
  };
}

module.exports = {
  isAdmin,
  isEditor,
  isViewer,
  canSeeSite,
  canManageSite,
  siteFilterClause,
  siteVisibleIds,
  requireSiteSee,
  requireSiteManage,
  requireRole,
};
