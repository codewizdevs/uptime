'use strict';

const express = require('express');
const { startLogin, finalizeDbLogin, complete2fa, logout, safeReturnTo, pendingNeeds2fa } = require('../auth');
const config = require('../config');
const logger = require('../logger');
const audit = require('../lib/audit');
const oidc = require('../lib/oidc');

const router = express.Router();

router.get('/login', async (req, res) => {
  if (req.session?.user) return res.redirect('/');
  // If a credentials check already passed and 2FA is pending, jump to /login/2fa.
  if (req.session?.pendingUser) {
    if (await pendingNeeds2fa(req)) return res.redirect('/login/2fa');
    delete req.session.pendingUser;
  }
  const local = req.query.local === '1';
  const signedOut = !!req.session?.signedOut;
  // SSO-only deployments go straight to the provider, so an expired session
  // costs the user nothing. Not after an explicit sign-out (the provider
  // would sign them straight back in), not when there's an error to show
  // (that would loop), and never on the break-glass page.
  const hasError = (res.locals.flash?.error || []).length > 0;
  if (config.oidc.enabled && config.oidc.disablePasswordLogin && !local && !signedOut && !hasError) {
    return res.redirect('/login/oidc');
  }
  res.render('login', {
    layout: false,
    title: 'Sign in',
    signedOut,
    oidc: config.oidc.enabled ? { label: config.oidc.buttonLabel } : null,
    // With OIDC_DISABLE_PASSWORD_LOGIN the form is hidden but stays reachable
    // at /login?local=1 so the env super-admin can still break glass.
    showPasswordForm: !config.oidc.enabled || !config.oidc.disablePasswordLogin || local,
  });
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (config.oidc.enabled && config.oidc.disablePasswordLogin
        && String(username || '').trim() !== config.admin.user) {
      req.flash('error', 'Password sign-in is disabled; use single sign-on');
      return res.redirect('/login');
    }
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

router.get('/login/oidc', async (req, res, next) => {
  if (!config.oidc.enabled) return res.redirect('/login');
  if (req.session?.user) return res.redirect('/');
  try {
    const { url, pending } = await oidc.beginLogin();
    req.session.oidcPending = pending;
    req.session.save((err) => (err ? next(err) : res.redirect(url)));
  } catch (err) {
    logger.error({ err: err.message }, 'oidc.begin_failed');
    req.flash('error', 'Single sign-on is unavailable right now');
    res.redirect('/login');
  }
});

router.get(oidc.CALLBACK_PATH, async (req, res, next) => {
  if (!config.oidc.enabled) return res.redirect('/login');
  const pending = req.session?.oidcPending;
  delete req.session.oidcPending;
  if (!pending || Date.now() - (pending.ts || 0) > 10 * 60 * 1000) {
    req.flash('error', 'Sign-in attempt expired, please try again');
    return res.redirect('/login');
  }
  if (req.query.error) {
    logger.warn({ error: req.query.error }, 'oidc.provider_error');
    req.flash('error', 'Sign-in was cancelled or refused by the identity provider');
    return res.redirect(pending.mode === 'link' ? '/settings/account' : '/login');
  }
  const linking = pending.mode === 'link';
  const failPath = linking ? '/settings/account' : '/login';
  if (linking && req.session?.user?.id !== pending.userId) {
    // Session ended or changed between "Connect SSO" and the callback.
    req.flash('error', 'Sign in again to connect single sign-on');
    return res.redirect('/login');
  }
  let claims;
  try {
    claims = await oidc.finishLogin(req.originalUrl, pending);
  } catch (err) {
    logger.warn({ err: err.message, error: err.error, description: err.error_description, ip: req.ip }, 'oidc.callback_failed');
    if (!linking) audit.fromReq(req, 'login.failed', { actor: 'oidc', meta: { reason: 'oidc_validation' } });
    req.flash('error', 'Single sign-on failed, please try again');
    return res.redirect(failPath);
  }
  if (linking) {
    try {
      const { error } = await oidc.linkUser(pending.userId, claims);
      if (error) {
        req.flash('error', error);
        return res.redirect(failPath);
      }
      audit.fromReq(req, 'account.sso_connected');
      req.flash('success', 'Single sign-on connected. You can now sign in with it.');
      return res.redirect('/settings/account');
    } catch (err) {
      logger.error({ err: err.message, ip: req.ip }, 'oidc.link_failed');
      req.flash('error', 'Single sign-on failed, please try again');
      return res.redirect(failPath);
    }
  }
  try {
    const { user, error, how, denied, roleChange } = await oidc.resolveUser(claims);
    if (error) {
      audit.fromReq(req, 'login.failed', { actor: String(claims.preferred_username || claims.sub), meta: { reason: denied ? 'oidc_no_group' : 'oidc_no_user' } });
      req.flash('error', error);
      return res.redirect('/login');
    }
    if (roleChange) {
      audit.fromReq(req, 'user.role_changed', { actor: 'oidc', targetType: 'user', targetId: user.id, meta: { ...roleChange, source: 'oidc' } });
    }
    if (user.disabled) {
      logger.warn({ username: user.username, ip: req.ip }, 'auth.login_disabled');
      audit.fromReq(req, 'login.failed', { actor: user.username, meta: { reason: 'disabled' } });
      req.flash('error', 'Account is disabled');
      return res.redirect('/login');
    }
    // Local TOTP is skipped: the identity provider owns MFA for these logins.
    await finalizeDbLogin(req, user, { method: 'oidc', how });
    const dest = safeReturnTo(req.session.returnTo);
    delete req.session.returnTo;
    req.flash('success', 'Welcome back!');
    res.redirect(dest);
  } catch (err) {
    // e.g. account creation failing on an unusable username. Details go to
    // the log; the user gets the same message as any other SSO failure.
    logger.error({ err: err.message, ip: req.ip }, 'oidc.login_failed');
    audit.fromReq(req, 'login.failed', { actor: 'oidc', meta: { reason: 'oidc_error' } });
    req.flash('error', 'Single sign-on failed, please try again');
    res.redirect('/login');
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
