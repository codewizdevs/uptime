'use strict';

const express = require('express');
const { attemptLogin, logout, safeReturnTo } = require('../auth');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.render('login', { layout: false, title: 'Sign in' });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!attemptLogin(req, username, password)) {
    req.flash('error', 'Invalid username or password');
    return res.redirect('/login');
  }
  const dest = safeReturnTo(req.session.returnTo);
  delete req.session.returnTo;
  req.flash('success', 'Welcome back!');
  res.redirect(dest);
});

router.post('/logout', async (req, res) => {
  await logout(req);
  res.redirect('/login');
});

module.exports = router;
