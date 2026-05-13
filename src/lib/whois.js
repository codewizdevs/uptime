'use strict';

// Domain expiry lookup. Tries RDAP first (clean JSON, growing TLD coverage),
// falls back to WHOIS over TCP/43 when no RDAP service is registered for the
// TLD. Both servers are discovered at runtime from the IANA bootstrap files
// (https://data.iana.org/rdap/dns.json + whois.iana.org), so we don't ship a
// hard-coded TLD map and gain new TLDs automatically.
//
// Public surface:
//   inspect(domain, { timeoutMs }) → {
//     ok: true, domain, expires_at: ISO|null, days_remaining: int|null,
//     registrar: string|null, status: string|null,
//     source: 'rdap' | 'whois', response_time_ms: int, raw: string,
//   }
// Throws on hard failure (network down, malformed input, no server found).
// If we connect but the registry redacts expiry, returns ok:true with
// expires_at:null so callers can mark the monitor `unknown` rather than down.

const net = require('net');
const { request } = require('undici');
const logger = require('../logger');

const IANA_RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const IANA_WHOIS_HOST = 'whois.iana.org';
const IANA_WHOIS_PORT = 43;

const BOOTSTRAP_TTL_MS = 6 * 60 * 60 * 1000; // refresh every 6h
const WHOIS_TLD_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // referrals rarely change

let _rdapBootstrap = null;
let _rdapBootstrapAt = 0;
const _whoisTldCache = new Map(); // tld → { server, at }

function isValidDomain(s) {
  if (!s || typeof s !== 'string') return false;
  const trimmed = s.trim().toLowerCase();
  // Reject schemes, paths, ports.
  if (/[:/\\\s]/.test(trimmed)) return false;
  // Must have at least one dot and end with a 2+ char TLD.
  return /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(trimmed);
}

function tldOf(domain) {
  const parts = String(domain).toLowerCase().split('.');
  return parts[parts.length - 1] || '';
}

async function loadRdapBootstrap() {
  if (_rdapBootstrap && Date.now() - _rdapBootstrapAt < BOOTSTRAP_TTL_MS) {
    return _rdapBootstrap;
  }
  try {
    const res = await request(IANA_RDAP_BOOTSTRAP_URL, {
      method: 'GET',
      headers: { 'accept': 'application/json' },
      bodyTimeout: 8000,
      headersTimeout: 8000,
    });
    if (res.statusCode !== 200) {
      throw new Error(`bootstrap http ${res.statusCode}`);
    }
    const json = await res.body.json();
    if (!json || !Array.isArray(json.services)) {
      throw new Error('bootstrap shape unexpected');
    }
    _rdapBootstrap = json;
    _rdapBootstrapAt = Date.now();
    return json;
  } catch (err) {
    logger.warn({ err: err.message }, 'whois.rdap_bootstrap_failed');
    // Hand back a stale copy if we have one, else null.
    return _rdapBootstrap;
  }
}

function rdapBaseFor(bootstrap, tld) {
  if (!bootstrap || !Array.isArray(bootstrap.services)) return null;
  for (const svc of bootstrap.services) {
    const tlds = svc[0] || [];
    const urls = svc[1] || [];
    if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;
    if (tlds.some((t) => String(t).toLowerCase() === tld)) {
      const url = urls.find((u) => /^https?:/.test(u)) || urls[0];
      if (url) return String(url).replace(/\/+$/, '');
    }
  }
  return null;
}

function pickFnFromVcard(vcardArray) {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return null;
  for (const entry of vcardArray[1] || []) {
    if (!Array.isArray(entry)) continue;
    if (entry[0] === 'fn' && typeof entry[3] === 'string') return entry[3];
  }
  return null;
}

function extractFromRdap(json) {
  if (!json || typeof json !== 'object') return {};
  let expires_at = null;
  if (Array.isArray(json.events)) {
    for (const ev of json.events) {
      const action = String(ev?.eventAction || '').toLowerCase();
      if (action === 'expiration' || action === 'expiry' || action === 'registry expiration') {
        const t = Date.parse(ev?.eventDate || '');
        if (Number.isFinite(t)) { expires_at = new Date(t).toISOString(); break; }
      }
    }
  }
  let registrar = null;
  if (Array.isArray(json.entities)) {
    for (const ent of json.entities) {
      const roles = (ent?.roles || []).map((r) => String(r).toLowerCase());
      if (roles.includes('registrar')) {
        const name = pickFnFromVcard(ent.vcardArray);
        if (name) { registrar = name; break; }
      }
    }
  }
  let status = null;
  if (Array.isArray(json.status) && json.status.length) {
    status = json.status.map(String).join(', ').slice(0, 200);
  }
  return { expires_at, registrar, status };
}

async function tryRdap(domain, timeoutMs) {
  const bootstrap = await loadRdapBootstrap();
  if (!bootstrap) return null;
  const base = rdapBaseFor(bootstrap, tldOf(domain));
  if (!base) return null;
  const url = `${base}/domain/${encodeURIComponent(domain)}`;
  const start = Date.now();
  try {
    const res = await request(url, {
      method: 'GET',
      headers: { 'accept': 'application/rdap+json, application/json' },
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
    });
    const elapsed = Date.now() - start;
    if (res.statusCode === 404) {
      return { ok: false, source: 'rdap', error: 'domain not found', response_time_ms: elapsed };
    }
    if (res.statusCode !== 200) {
      // 429 (rate-limit), 5xx → let WHOIS take over.
      logger.debug({ statusCode: res.statusCode, url }, 'whois.rdap_bad_status');
      return null;
    }
    const json = await res.body.json();
    const fields = extractFromRdap(json);
    return {
      ok: true,
      source: 'rdap',
      response_time_ms: elapsed,
      raw: JSON.stringify(json).slice(0, 8 * 1024),
      ...fields,
    };
  } catch (err) {
    logger.debug({ err: err.message, url }, 'whois.rdap_fetch_failed');
    return null;
  }
}

// ── WHOIS over TCP/43 ────────────────────────────────────────────────────

function whoisQuery(host, port, query, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    const chunks = [];
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(value);
    };
    socket.once('connect', () => {
      socket.write(query + '\r\n');
    });
    socket.on('data', (b) => {
      chunks.push(b);
      if (Buffer.concat(chunks).length > 256 * 1024) done(new Error('whois: response too large'));
    });
    socket.once('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
    socket.once('close', () => done(null, Buffer.concat(chunks).toString('utf8')));
    socket.once('error', (err) => done(err));
    socket.once('timeout', () => done(new Error('whois: timeout')));
  });
}

async function resolveWhoisServer(tld, timeoutMs) {
  const cached = _whoisTldCache.get(tld);
  if (cached && Date.now() - cached.at < WHOIS_TLD_CACHE_TTL_MS) {
    return cached.server;
  }
  const text = await whoisQuery(IANA_WHOIS_HOST, IANA_WHOIS_PORT, tld, timeoutMs);
  const m = /^\s*whois:\s*([\w.-]+)\s*$/im.exec(text);
  const server = m ? m[1].trim() : null;
  if (server) _whoisTldCache.set(tld, { server, at: Date.now() });
  return server;
}

// Patterns ordered by specificity. First match wins.
const EXPIRY_PATTERNS = [
  /Registry Expiry Date:\s*([^\r\n]+)/i,
  /Registrar Registration Expiration Date:\s*([^\r\n]+)/i,
  /Expiration Time:\s*([^\r\n]+)/i,
  /Expiration Date:\s*([^\r\n]+)/i,
  /Expiry Date:\s*([^\r\n]+)/i,
  /paid-till:\s*([^\r\n]+)/i,           // .ru / .su
  /Renewal date:\s*([^\r\n]+)/i,        // .fi
  /expire:\s*([^\r\n]+)/i,              // .fr / .re
  /Expires On:\s*([^\r\n]+)/i,
  /^expires:\s*([^\r\n]+)/im,           // .ee / .lv
  /Valid Until:\s*([^\r\n]+)/i,
  /Domain Expiration Date:\s*([^\r\n]+)/i,
];

const REGISTRAR_PATTERNS = [
  /^Registrar:\s*([^\r\n]+)/im,
  /^Sponsoring Registrar:\s*([^\r\n]+)/im,
  /^registrar:\s*([^\r\n]+)/im,
];

const STATUS_PATTERNS = [
  /^Domain Status:\s*([^\r\n]+)/im,
  /^status:\s*([^\r\n]+)/im,
];

function parseWhoisDate(s) {
  if (!s) return null;
  const trimmed = String(s).trim();
  // Strip trailing parentheticals "(UTC)" / explanatory tails after the date.
  const cleaned = trimmed.replace(/\s*\(.*$/, '').trim();
  const t = Date.parse(cleaned);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  // Try DD-MMM-YYYY / DD.MM.YYYY.
  const m1 = /^(\d{1,2})[-/. ](\w{3,9}|\d{1,2})[-/. ](\d{2,4})$/.exec(cleaned);
  if (m1) {
    const day = m1[1].padStart(2, '0');
    const monStr = m1[2];
    const year = (m1[3].length === 2 ? '20' + m1[3] : m1[3]);
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const mon = months[monStr.slice(0, 3).toLowerCase()] || monStr.padStart(2, '0');
    const t2 = Date.parse(`${year}-${mon}-${day}T00:00:00Z`);
    if (Number.isFinite(t2)) return new Date(t2).toISOString();
  }
  return null;
}

function extractFromWhois(text) {
  let expires_at = null;
  for (const re of EXPIRY_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      expires_at = parseWhoisDate(m[1]);
      if (expires_at) break;
    }
  }
  let registrar = null;
  for (const re of REGISTRAR_PATTERNS) {
    const m = re.exec(text);
    if (m) { registrar = m[1].trim().slice(0, 200); break; }
  }
  const statuses = [];
  for (const re of STATUS_PATTERNS) {
    let m; const reGlobal = new RegExp(re.source, 'gim');
    while ((m = reGlobal.exec(text)) !== null) {
      const s = m[1].trim().replace(/\s+https?:\/\/\S+/, ''); // drop EPP URLs
      if (s) statuses.push(s);
      if (statuses.length >= 6) break;
    }
    if (statuses.length) break;
  }
  return { expires_at, registrar, status: statuses.length ? statuses.join(', ').slice(0, 200) : null };
}

async function tryWhois(domain, timeoutMs) {
  const tld = tldOf(domain);
  if (!tld) return { ok: false, source: 'whois', error: 'invalid tld' };
  const server = await resolveWhoisServer(tld, timeoutMs).catch(() => null);
  if (!server) return { ok: false, source: 'whois', error: `no whois server for .${tld}` };
  const start = Date.now();
  // Verisign-style servers (.com/.net/.cc/.tv) need "DOMAIN <name>" to avoid
  // a list response when the name is short / could match many.
  const useDomainPrefix = /verisign-grs|whois\.verisign|whois\.nic/i.test(server);
  const queryString = useDomainPrefix ? `domain ${domain}` : domain;
  const text = await whoisQuery(server, IANA_WHOIS_PORT, queryString, timeoutMs);
  const elapsed = Date.now() - start;
  const fields = extractFromWhois(text);
  return {
    ok: true,
    source: 'whois',
    response_time_ms: elapsed,
    raw: text.slice(0, 8 * 1024),
    ...fields,
  };
}

async function inspect(domain, options = {}) {
  const timeoutMs = Math.max(2000, Math.min(60000, options.timeoutMs || 12000));
  const trimmed = String(domain || '').trim().toLowerCase();
  if (!isValidDomain(trimmed)) {
    throw new Error('whois: invalid domain (expected apex like "example.com")');
  }

  // RDAP first.
  let result = await tryRdap(trimmed, timeoutMs);
  if (result && result.ok) {
    return finalize(trimmed, result);
  }
  if (result && !result.ok && result.error === 'domain not found') {
    // RDAP authoritatively says no such domain; trust it.
    return { ok: false, domain: trimmed, error: 'domain not found', source: 'rdap', response_time_ms: result.response_time_ms };
  }

  // Fall back to WHOIS.
  result = await tryWhois(trimmed, timeoutMs);
  if (!result.ok) {
    throw new Error(result.error || 'whois lookup failed');
  }
  return finalize(trimmed, result);
}

function finalize(domain, r) {
  const daysRemaining = r.expires_at
    ? Math.floor((new Date(r.expires_at).getTime() - Date.now()) / 86_400_000)
    : null;
  return {
    ok: true,
    domain,
    expires_at: r.expires_at || null,
    days_remaining: daysRemaining,
    registrar: r.registrar || null,
    status: r.status || null,
    source: r.source,
    response_time_ms: r.response_time_ms,
    raw: r.raw,
  };
}

module.exports = {
  inspect,
  // Exposed for tests.
  _internal: { extractFromWhois, extractFromRdap, parseWhoisDate, isValidDomain },
};
