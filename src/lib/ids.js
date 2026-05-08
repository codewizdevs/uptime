'use strict';

function parseId(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function notFound(req, res, message = 'Not found') {
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(404).json({ error: message });
  }
  return res.status(404).render('error', { title: 'Not found', error: message });
}

function idParam(req, res, next, raw) {
  if (parseId(raw) == null) return notFound(req, res, 'Invalid id');
  next();
}

module.exports = { parseId, idParam, notFound };
