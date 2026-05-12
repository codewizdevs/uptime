'use strict';

const express = require('express');
const tags = require('../lib/tags');
const logger = require('../logger');
const audit = require('../lib/audit');
const acl = require('../lib/acl');
const { parseId, idParam } = require('../lib/ids');

const router = express.Router();
router.param('id', idParam);

const requireAdmin = acl.requireRole('admin');

router.get('/settings/tags', requireAdmin, async (req, res, next) => {
  try {
    const list = await tags.listTags();
    res.render('settings-tags', {
      title: 'Tags',
      tags: list,
      palette: tags.COLOR_PALETTE,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/tags', requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      req.flash('error', 'Tag name is required');
      return res.redirect('/settings/tags');
    }
    const id = await tags.createTag(name, req.body.color);
    audit.fromReq(req, 'tag.created', { targetType: 'tag', targetId: id, meta: { name } });
    logger.info({ name }, 'tags.created');
    req.flash('success', `Tag "${name}" created`);
    res.redirect('/settings/tags');
  } catch (err) {
    if (String(err.message || '').toLowerCase().includes('unique')) {
      req.flash('error', 'A tag with that name already exists');
      return res.redirect('/settings/tags');
    }
    next(err);
  }
});

router.post('/settings/tags/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/tags');
    const name = (req.body.name || '').trim();
    if (!name) {
      req.flash('error', 'Tag name is required');
      return res.redirect('/settings/tags');
    }
    await tags.updateTag(id, name, req.body.color);
    audit.fromReq(req, 'tag.updated', { targetType: 'tag', targetId: id, meta: { name } });
    logger.info({ id, name }, 'tags.updated');
    req.flash('success', 'Tag updated');
    res.redirect('/settings/tags');
  } catch (err) {
    if (String(err.message || '').toLowerCase().includes('unique')) {
      req.flash('error', 'A tag with that name already exists');
      return res.redirect('/settings/tags');
    }
    next(err);
  }
});

router.post('/settings/tags/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id == null) return res.redirect('/settings/tags');
    await tags.deleteTag(id);
    audit.fromReq(req, 'tag.deleted', { targetType: 'tag', targetId: id });
    logger.info({ id }, 'tags.deleted');
    req.flash('success', 'Tag deleted');
    res.redirect('/settings/tags');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
