#!/usr/bin/env node
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const db = require('../src/db');

const COUNT = parseInt(process.argv[2], 10) || 150;

const SERVICES = [
  'API', 'Web', 'Admin', 'Auth', 'Billing', 'Checkout', 'Search', 'CDN', 'Image proxy',
  'Status page', 'Wiki', 'Docs', 'Mailer', 'Worker', 'Queue', 'Cache', 'Database admin',
  'Webhooks', 'Login', 'Realtime', 'Metrics', 'Logs', 'Backup', 'Crawler', 'Scheduler',
  'Reports', 'Inventory', 'Storefront', 'CMS', 'Forum', 'Support portal', 'Identity',
  'Notifications', 'Analytics', 'Tracking', 'Media', 'Maps', 'Geo', 'Translation',
  'Feature flags', 'Config', 'Webhook receiver', 'Ingest', 'Importer', 'Exporter',
  'Print service', 'Render farm', 'Build server', 'Artifact store', 'Package mirror',
];
const ENVS = ['prod', 'staging', 'dev', 'eu', 'us', 'asia', 'edge', 'internal'];
const DOMAINS = [
  'example.com', 'service.io', 'corp.local', 'cloudwiz.dev', 'platform.app',
  'apex.cloud', 'edge.run', 'svc.team', 'infra.zone', 'codewizdev.com',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function chance(p) { return Math.random() < p; }

function randName(used) {
  while (true) {
    const svc = pick(SERVICES);
    const env = chance(0.85) ? ' - ' + pick(ENVS) : '';
    const num = chance(0.2) ? ' #' + (1 + Math.floor(Math.random() * 9)) : '';
    const name = svc + env + num;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
}

function nameToSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'svc';
}

function randomActive(used) {
  const name = randName(used);
  const domain = pick(DOMAINS);
  const slug = nameToSlug(name);
  const subdomain = chance(0.5) ? slug + '.' : '';
  const path = chance(0.6) ? '/' + (chance(0.5) ? 'health' : 'status') : '';
  const url = 'https://' + subdomain + domain + path;
  return {
    name,
    url,
    monitor_type: 'active',
    method: chance(0.85) ? 'GET' : 'HEAD',
    interval_seconds: pick([30, 60, 60, 60, 120, 300]),
    timeout_ms: pick([5000, 10000, 10000, 15000]),
    check_type: chance(0.7) ? 'status' : (chance(0.5) ? 'string' : 'json'),
    expected_status: '200',
    failure_threshold: pick([1, 1, 1, 2, 3]),
    cloudflare_mode: chance(0.25) ? 1 : 0,
    paused: chance(0.07) ? 1 : 0,
    current_state: pick(['up', 'up', 'up', 'up', 'up', 'up', 'up', 'down', 'unknown', 'unknown']),
  };
}

function randomHeartbeat(used) {
  const name = randName(used);
  return {
    name,
    url: '',
    monitor_type: 'heartbeat',
    method: 'GET',
    interval_seconds: pick([60, 300, 600, 1800, 3600]),
    timeout_ms: 10000,
    check_type: null,
    expected_status: null,
    failure_threshold: 1,
    heartbeat_grace_seconds: pick([30, 60, 120, 300]),
    heartbeat_token: crypto.randomBytes(16).toString('hex'),
    cloudflare_mode: 0,
    paused: chance(0.05) ? 1 : 0,
    current_state: pick(['up', 'up', 'up', 'up', 'down', 'unknown', 'unknown']),
  };
}

async function main() {
  const used = new Set();
  const existing = await db.query('SELECT name FROM sites');
  existing.forEach((r) => used.add(r.name));

  console.log(`Seeding ${COUNT} monitors...`);

  let active = 0, heartbeat = 0, paused = 0;
  for (let i = 0; i < COUNT; i++) {
    const m = chance(0.7) ? randomActive(used) : randomHeartbeat(used);
    if (m.monitor_type === 'active') active++; else heartbeat++;
    if (m.paused) paused++;

    await db.query(
      `INSERT INTO sites
         (name, url, monitor_type, method, interval_seconds, timeout_ms,
          check_type, expected_status, failure_threshold, heartbeat_token,
          heartbeat_grace_seconds, cloudflare_mode, paused, current_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        m.name, m.url, m.monitor_type, m.method, m.interval_seconds, m.timeout_ms,
        m.check_type, m.expected_status, m.failure_threshold, m.heartbeat_token || null,
        m.heartbeat_grace_seconds || 60, m.cloudflare_mode, m.paused, m.current_state,
      ]
    );
  }

  const total = await db.query('SELECT COUNT(*) AS n FROM sites');
  console.log(`Done. Inserted ${active} active + ${heartbeat} heartbeat (${paused} paused).`);
  console.log(`Total monitors in DB now: ${total[0].n}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
