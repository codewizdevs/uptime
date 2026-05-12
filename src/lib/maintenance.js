'use strict';

// Maintenance windows: planned outages where alerts (and optionally probes)
// are suppressed. Two flavours:
//   - one-off  : explicit start_at / end_at instants in UTC
//   - recurring: cron expression + duration_minutes, evaluated in a timezone
//
// Public API:
//   listWindows()
//   getWindow(id)
//   isActive(siteId)          → window object or null
//   isActiveGlobal()          → window object or null
//   windowIsActive(w, [now])  → boolean (pure)
//   nextOccurrence(w, [now])  → Date | null
//   currentEnd(w, [now])      → Date | null (when the active window will end)

const db = require('../db');
const logger = require('../logger');
const cronParser = require('cron-parser');

const cache = {
  list: null,
  loadedAt: 0,
  TTL_MS: 15_000,
};

function invalidateCache() {
  cache.list = null;
  cache.loadedAt = 0;
}

async function listWindows({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache.list && (now - cache.loadedAt) < cache.TTL_MS) {
    return cache.list;
  }
  const rows = await db.query(
    `SELECT * FROM maintenance_windows ORDER BY enabled DESC, name ASC`
  );
  cache.list = rows;
  cache.loadedAt = now;
  return rows;
}

async function getWindow(id) {
  const rows = await db.query(`SELECT * FROM maintenance_windows WHERE id = ?`, [id]);
  return rows[0] || null;
}

function toDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const d = new Date(s);
  return Number.isNaN(d.valueOf()) ? null : d;
}

// Returns true if `now` falls inside any occurrence of window `w`.
function windowIsActive(w, now = new Date()) {
  if (!w || !w.enabled) return false;
  const at = +now;
  if (w.kind === 'oneoff') {
    const s = toDate(w.starts_at);
    const e = toDate(w.ends_at);
    if (!s || !e) return false;
    return at >= +s && at <= +e;
  }
  if (w.kind === 'recurring') {
    if (!w.cron || !w.duration_minutes) return false;
    const tz = w.timezone || 'UTC';
    let it;
    try {
      // currentDate=now, then prev() gives the most recent start <= now.
      it = cronParser.CronExpressionParser.parse(w.cron, { currentDate: now, tz });
    } catch {
      return false;
    }
    let prevStart;
    try { prevStart = it.prev().toDate(); } catch { return false; }
    const end = new Date(+prevStart + Number(w.duration_minutes) * 60_000);
    return at >= +prevStart && at <= +end;
  }
  return false;
}

function nextOccurrence(w, now = new Date()) {
  if (!w || !w.enabled) return null;
  if (w.kind === 'oneoff') {
    const s = toDate(w.starts_at);
    if (!s) return null;
    return +s > +now ? s : null;
  }
  if (w.kind === 'recurring') {
    if (!w.cron) return null;
    const tz = w.timezone || 'UTC';
    try {
      const it = cronParser.CronExpressionParser.parse(w.cron, { currentDate: now, tz });
      return it.next().toDate();
    } catch { return null; }
  }
  return null;
}

function currentEnd(w, now = new Date()) {
  if (!w || !windowIsActive(w, now)) return null;
  if (w.kind === 'oneoff') return toDate(w.ends_at);
  if (w.kind === 'recurring') {
    try {
      const it = cronParser.CronExpressionParser.parse(w.cron, {
        currentDate: now,
        tz: w.timezone || 'UTC',
      });
      const prevStart = it.prev().toDate();
      return new Date(+prevStart + Number(w.duration_minutes) * 60_000);
    } catch { return null; }
  }
  return null;
}

function windowAppliesToSite(w, siteId) {
  if (!w) return false;
  if (w.scope === 'global') return true;
  if (w.scope === 'monitor') return Number(w.scope_value) === Number(siteId);
  return false;
}

async function isActiveGlobal(now = new Date()) {
  const rows = await listWindows();
  for (const w of rows) {
    if (w.scope === 'global' && windowIsActive(w, now)) return w;
  }
  return null;
}

async function isActive(siteId, now = new Date()) {
  if (!siteId) return null;
  const rows = await listWindows();
  for (const w of rows) {
    if (!windowAppliesToSite(w, siteId)) continue;
    if (windowIsActive(w, now)) return w;
  }
  return null;
}

async function isAlertSuppressed(siteId, now = new Date()) {
  const w = await isActive(siteId, now);
  if (!w) return null;
  return w.suppress_notifications ? w : null;
}

async function isProbeSuppressed(siteId, now = new Date()) {
  const w = await isActive(siteId, now);
  if (!w) return null;
  return w.pause_probes ? w : null;
}

function validateCron(expr) {
  if (!expr || !String(expr).trim()) return { ok: false, error: 'cron expression required' };
  try {
    cronParser.CronExpressionParser.parse(String(expr).trim());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function summarize(w, now = new Date()) {
  if (!w) return '';
  if (!w.enabled) return 'disabled';
  if (windowIsActive(w, now)) {
    const end = currentEnd(w, now);
    return end ? `active now (ends ${end.toISOString()})` : 'active now';
  }
  const next = nextOccurrence(w, now);
  if (next) return `next at ${next.toISOString()}`;
  return 'idle';
}

module.exports = {
  listWindows,
  getWindow,
  invalidateCache,
  windowIsActive,
  windowAppliesToSite,
  nextOccurrence,
  currentEnd,
  isActive,
  isActiveGlobal,
  isAlertSuppressed,
  isProbeSuppressed,
  validateCron,
  summarize,
};

logger.trace('maintenance.module_loaded');
