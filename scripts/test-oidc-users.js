#!/usr/bin/env node
'use strict';

// Exercises the OIDC identity → user mapping in src/lib/oidc.js against a
// throwaway SQLite database. No identity provider needed:
//
//   node scripts/test-oidc-users.js
//
// To run against an empty MySQL database instead, set DB_DRIVER=mysql and the
// DB_* connection variables.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-oidc-'));
// Set before src/config loads; dotenv never overrides existing variables.
Object.assign(process.env, {
  DB_DRIVER: process.env.DB_DRIVER || 'sqlite',
  SQLITE_PATH: path.join(dir, 'test.sqlite'),
  ADMIN_USER: 'admin',
  OIDC_ISSUER: 'https://id.example.test',
  OIDC_CLIENT_ID: 'test',
  OIDC_ADMIN_GROUP: 'uptime-admins',
  OIDC_EDITOR_GROUP: 'uptime-editors',
  OIDC_VIEWER_GROUP: '*',
  OIDC_AUTO_CREATE: 'true',
});

const db = require('../src/db');
const users = require('../src/lib/users');
const oidc = require('../src/lib/oidc');
const config = require('../src/config');
const { startLogin } = require('../src/auth');

async function main() {
  await db.ensureSchema();
  await require('../src/lib/migrations').run();

  const ISS = 'https://id.example.test';
  const id = (sub, extra = {}) => ({ iss: ISS, sub, ...extra });

  const bob = await users.create({ username: 'bob', password: 'password123', role: 'viewer', email: 'Bob@Example.com' });
  const boss = await users.create({ username: 'boss', password: 'password123', role: 'admin' });

  // A matching email never links, verified or not: the local email is
  // user-editable, so it proves nothing. SSO gets its own account.
  let r = await oidc.resolveUser(id('s1', { email: 'bob@example.com', email_verified: true, preferred_username: 'bob' }));
  assert.strictEqual(r.how, 'created');
  assert.notStrictEqual(r.user.id, bob.id);
  assert.strictEqual(r.user.username, 'bob-2');
  assert.strictEqual(r.user.auth_source, 'oidc');

  // Later logins match on (iss, sub); role re-synced from groups.
  r = await oidc.resolveUser(id('s1', { groups: ['uptime-editors', 'uptime-admins'] }));
  assert.strictEqual(r.how, 'sub');
  assert.strictEqual(r.user.role, 'admin');
  r = await oidc.resolveUser(id('s1', { groups: [] }));
  assert.strictEqual(r.user.role, 'viewer');
  assert.deepStrictEqual(r.roleChange, { from: 'admin', to: 'viewer' });

  // The last active DB admin is never demoted by group sync.
  await users.updateRole(boss.id, 'viewer');
  r = await oidc.resolveUser(id('s1', { groups: ['uptime-admins'] }));
  assert.strictEqual(r.user.role, 'admin');
  r = await oidc.resolveUser(id('s1', { groups: [] }));
  assert.strictEqual(r.user.role, 'admin');
  assert.strictEqual(r.roleChange, null);
  await users.updateRole(boss.id, 'admin');

  // Without a wildcard, users in no configured group are refused, new or not.
  config.oidc.viewerGroup = 'uptime-viewers';
  r = await oidc.resolveUser(id('s1', { groups: ['other'] }));
  assert.ok(r.error && r.denied);
  r = await oidc.resolveUser(id('brand-new', { groups: [] }));
  assert.ok(r.error && r.denied);
  assert.strictEqual(await users.findByOidcIdentity(ISS, 'brand-new'), null);
  r = await oidc.resolveUser(id('s1', { groups: ['uptime-viewers'] }));
  assert.strictEqual(r.user.role, 'viewer');
  // Group names with spaces in a comma-separated string claim.
  config.oidc.adminGroup = 'Uptime Admins';
  assert.strictEqual(oidc.roleFromClaims({ groups: 'Uptime Admins, other' }), 'admin');
  config.oidc.adminGroup = 'uptime-admins';
  config.oidc.viewerGroup = '*';

  // The same subject from another issuer is a different identity.
  r = await oidc.resolveUser({ iss: 'https://other.example.test', sub: 's1', preferred_username: 'bob' });
  assert.strictEqual(r.how, 'created');
  assert.strictEqual(r.user.username, 'bob-3');

  // Subjects are case-sensitive.
  const lower = await oidc.resolveUser(id('case-sub', { preferred_username: 'lc' }));
  const upper = await oidc.resolveUser(id('CASE-SUB', { preferred_username: 'uc' }));
  assert.notStrictEqual(lower.user.id, upper.user.id);

  // Connect SSO: a local user links their own account.
  r = await oidc.linkUser(bob.id, id('bob-sso'));
  assert.ok(r.ok);
  r = await oidc.resolveUser(id('bob-sso'));
  assert.strictEqual(r.user.id, bob.id);
  assert.strictEqual(r.user.auth_source, 'local');
  // Already connected; identity owned by someone else; SSO-created accounts.
  assert.ok((await oidc.linkUser(bob.id, id('another'))).error);
  const carl = await users.create({ username: 'carl', password: 'password123', role: 'viewer' });
  assert.ok((await oidc.linkUser(carl.id, id('bob-sso'))).error);
  assert.ok((await oidc.linkUser(lower.user.id, id('fresh'))).error);
  // A linked identity is never overwritten.
  assert.strictEqual(await users.linkOidcIdentity(bob.id, ISS, 'someone-else'), false);
  assert.strictEqual((await users.findByOidcIdentity(ISS, 'bob-sso')).id, bob.id);

  // Disconnect: local accounts only.
  assert.strictEqual(await users.unlinkOidcIdentity(lower.user.id), false);
  assert.strictEqual(await users.unlinkOidcIdentity(bob.id), true);
  assert.strictEqual(await users.findByOidcIdentity(ISS, 'bob-sso'), null);

  // SSO-created accounts never sign in with a password.
  const sso = await users.getById(lower.user.id);
  await users.setPassword(sso.id, 'password123');
  const req = { ip: '127.0.0.1', session: {}, get: () => '' };
  const login = await startLogin(req, sso.username, 'password123');
  assert.strictEqual(login.ok, false);
  assert.ok((await startLogin(req, 'carl', 'password123')).ok);

  // Usernames: reserved env-admin name, invalid characters, email fallback.
  r = await oidc.resolveUser(id('s4', { preferred_username: 'Admin' }));
  assert.strictEqual(r.user.username, 'admin-2');
  r = await oidc.resolveUser(id('s5', { preferred_username: 'Jöhn Smith!' }));
  assert.strictEqual(r.user.username, 'jhnsmith');
  r = await oidc.resolveUser(id('s6', { email: 'carol@example.com' }));
  assert.strictEqual(r.user.username, 'carol');
  r = await oidc.resolveUser(id('s7', { preferred_username: 'x' }));
  assert.strictEqual(r.user.username, 'user');

  // Missing subject or issuer is rejected.
  assert.ok((await oidc.resolveUser({})).error);
  assert.ok((await oidc.resolveUser({ sub: 'no-iss' })).error);

  // Disabled accounts are returned unchanged (no role sync) for the caller
  // to refuse.
  const dis = await oidc.resolveUser(id('dis', { preferred_username: 'dis' }));
  await users.setDisabled(dis.user.id, true);
  r = await oidc.resolveUser(id('dis', { groups: ['uptime-admins'] }));
  assert.strictEqual(r.user.disabled, true);
  assert.strictEqual(r.user.role, 'viewer');
  assert.strictEqual(r.roleChange, null);

  // Comma-separated string groups claim; spaces belong to the name.
  assert.deepStrictEqual(oidc.groupsFromClaims({ groups: 'a, b c' }), ['a', 'b c']);

  // Startup check refuses a config where nobody could sign in.
  const saved = { ...config.oidc };
  Object.assign(config.oidc, { adminGroup: '', editorGroup: '', viewerGroup: '' });
  assert.throws(() => oidc.checkConfig(), /OIDC_VIEWER_GROUP/);
  Object.assign(config.oidc, saved);
  oidc.checkConfig();

  // Plain-http issuers need OIDC_ALLOW_HTTP_ISSUER.
  config.oidc.issuer = 'http://pocketid:1411';
  assert.throws(() => oidc.checkConfig(), /OIDC_ALLOW_HTTP_ISSUER/);
  config.oidc.allowHttpIssuer = true;
  oidc.checkConfig();
  Object.assign(config.oidc, saved);

  // Password sign-in disabled requires a non-default ADMIN_PASS.
  config.oidc.disablePasswordLogin = true;
  config.admin.passIsDefault = true;
  assert.throws(() => oidc.checkConfig(), /ADMIN_PASS/);
  config.admin.passIsDefault = false;
  oidc.checkConfig();
  config.oidc.disablePasswordLogin = false;

  // Parallel first logins for one identity yield a single account.
  const [p1, p2] = await Promise.all([
    oidc.resolveUser(id('s9', { preferred_username: 'erin' })),
    oidc.resolveUser(id('s9', { preferred_username: 'erin' })),
  ]);
  assert.strictEqual(p1.user.id, p2.user.id);

  // Auto-create off: unknown identities are refused.
  config.oidc.autoCreate = false;
  r = await oidc.resolveUser(id('s8', { preferred_username: 'dave' }));
  assert.ok(r.error);
  config.oidc.autoCreate = true;

  console.log('oidc user mapping: all checks passed');
}

main()
  .then(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); })
  .catch((err) => { console.error(err); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); });
