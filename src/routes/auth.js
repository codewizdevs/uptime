'use strict';

const express = require('express');
const { startLogin, complete2fa, logout, safeReturnTo, pendingNeeds2fa } = require('../auth');

const router = express.Router();

router.get('/login', async (req, res) => {
  if (req.session?.user) return res.redirect('/');
  // If a credentials check already passed and 2FA is pending, jump to /login/2fa.
  if (req.session?.pendingUser) {
    if (await pendingNeeds2fa(req)) return res.redirect('/login/2fa');
    delete req.session.pendingUser;
  }
  res.render('login', { layout: false, title: 'Sign in' });
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const result = await startLogin(req, username, password);
    if (!result.ok) {
      req.flash('error', result.message || 'Invalid username or password');
      return res.redirect('/login');
    }
    if (result.needs2fa) {
      return res.redirect('/login/2fa');
    }
    const dest = safeReturnTo(req.session.returnTo);
    delete req.session.returnTo;
    req.flash('success', 'Welcome back!');
    res.redirect(dest);
  } catch (err) {
    next(err);
  }
});

router.get('/login/2fa', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  if (!req.session?.pendingUser) return res.redirect('/login');
  res.render('login-2fa', { layout: false, title: 'Two-factor code' });
});

router.post('/login/2fa', async (req, res, next) => {
  try {
    if (req.session?.user) return res.redirect('/');
    if (!req.session?.pendingUser) return res.redirect('/login');
    const result = await complete2fa(req, req.body.code);
    if (!result.ok) {
      req.flash('error', result.message);
      return res.redirect('/login/2fa');
    }
    const dest = safeReturnTo(req.session.returnTo);
    delete req.session.returnTo;
    req.flash('success', result.recovery
      ? 'Welcome back. Recovery code used — generate fresh ones in Settings → Two-factor.'
      : 'Welcome back!');
    res.redirect(dest);
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res) => {
  await logout(req);
  res.redirect('/login');
});

module.exports = router;
