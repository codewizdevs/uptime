'use strict';

const zlib = require('zlib');
const { promisify } = require('util');
const { Agent, request } = require('undici');
const cf = require('./cloudflare');
const cert = require('./cert');
const tcpProbe = require('./tcp');
const pingProbe = require('./ping');
const dnsProbe = require('./dnscheck');
const whois = require('./whois');
const logger = require('../logger');

const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);
const inflateRawAsync = promisify(zlib.inflateRaw);
const brotliAsync = promisify(zlib.brotliDecompress);

// Decode HTTP response bytes per Content-Encoding so body assertions and
// JSON parsing work against the actual payload, not raw compressed bytes.
async function decodeBody(buf, contentEncoding) {
  if (!buf || !buf.length) return '';
  if (!contentEncoding) return buf.toString('utf8');
  const layers = String(contentEncoding).toLowerCase().split(',')
    .map((s) => s.trim()).filter(Boolean);
  let cur = buf;
  for (let i = layers.length - 1; i >= 0; i--) {
    const enc = layers[i];
    try {
      if (enc === 'gzip' || enc === 'x-gzip') cur = await gunzipAsync(cur);
      else if (enc === 'br') cur = await brotliAsync(cur);
      else if (enc === 'deflate') {
        try { cur = await inflateAsync(cur); }
        catch { cur = await inflateRawAsync(cur); }
      } else if (enc === 'identity') {
        // no-op
      } else {
        return cur.toString('utf8');
      }
    } catch {
      return cur.toString('utf8');
    }
  }
  return cur.toString('utf8');
}

const sharedAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 32,
  pipelining: 1,
  connect: { rejectUnauthorized: true },
});

function parseExpectedStatus(raw) {
  if (!raw) return [200];
  return String(raw)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

function getJsonPath(obj, dotPath) {
  if (!dotPath) return undefined;
  const parts = String(dotPath).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    const arr = /^\[(\d+)\]$/.exec(p);
    if (arr) {
      cur = cur[parseInt(arr[1], 10)];
      continue;
    }
    const m = /^(.+?)\[(\d+)\]$/.exec(p);
    if (m) {
      cur = cur?.[m[1]]?.[parseInt(m[2], 10)];
      continue;
    }
    cur = cur[p];
  }
  return cur;
}

function buildHeaders(site) {
  const headers = {
    'User-Agent': cf.pickUserAgent(site.id),
    ...cf.DEFAULT_BROWSER_HEADERS,
  };
  if (site.request_headers) {
    let extra = site.request_headers;
    if (typeof extra === 'string') {
      try {
        extra = JSON.parse(extra);
      } catch {
        extra = null;
      }
    }
    if (extra && typeof extra === 'object') {
      for (const [k, v] of Object.entries(extra)) headers[k] = String(v);
    }
  }
  // Per-monitor auth — explicit fields beat any Authorization in request_headers.
  if (site.auth_type === 'basic' && site.auth_username != null) {
    const user = String(site.auth_username || '');
    const pass = String(site.auth_password || '');
    headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  } else if (site.auth_type === 'bearer' && site.auth_token) {
    headers.Authorization = `Bearer ${String(site.auth_token).trim()}`;
  }
  return headers;
}

// Cache dispatchers per (skip-tls, max-redirects) tuple so we don't churn TCP
// connections when many monitors share the same probe options.
const tlsRelaxedAgents = new Map();
function dispatcherFor(site) {
  if (!site.skip_tls_verify) return sharedAgent;
  const key = 'skip-tls';
  let a = tlsRelaxedAgents.get(key);
  if (!a) {
    a = new Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: 16,
      pipelining: 1,
      connect: { rejectUnauthorized: false },
    });
    tlsRelaxedAgents.set(key, a);
  }
  return a;
}

function pickRequestBody(site) {
  const m = (site.method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return { body: null, contentType: null };
  const body = site.request_body;
  if (body == null || body === '') return { body: null, contentType: null };
  const t = (site.request_body_type || 'text').toLowerCase();
  let contentType = null;
  if (t === 'json') contentType = 'application/json';
  else if (t === 'form') contentType = 'application/x-www-form-urlencoded';
  else if (t === 'text') contentType = 'text/plain; charset=utf-8';
  return { body: String(body), contentType };
}

async function fetchWithTiming({ method, url, headers, timeoutMs, body: requestBody, maxRedirections, dispatcher }) {
  const start = process.hrtime.bigint();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const opts = {
      method,
      headers,
      dispatcher: dispatcher || sharedAgent,
      signal: ac.signal,
      maxRedirections: Number.isFinite(maxRedirections) ? maxRedirections : 5,
    };
    if (requestBody != null && requestBody !== '' && method !== 'GET' && method !== 'HEAD') {
      opts.body = requestBody;
    }
    const res = await request(url, opts);
    const headersObj = {};
    for (const [k, v] of Object.entries(res.headers)) {
      headersObj[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    }
    let body = '';
    if (method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of res.body) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      body = await decodeBody(buf, headersObj['content-encoding']);
    } else {
      res.body.resume();
    }
    const ns = process.hrtime.bigint() - start;
    return {
      status: res.statusCode,
      headers: headersObj,
      body,
      responseTimeMs: Number(ns / 1_000_000n),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Run a TLS handshake against the URL's host:port (best-effort, swallowing
// errors) and return summarized cert info. We intentionally pass
// rejectUnauthorized=false here so we can still surface info about an
// expired or self-signed cert.
async function captureCertSideChannel(site) {
  try {
    if (!site || !site.url || !/^https:\/\//i.test(site.url)) return null;
    const info = await cert.inspect(site.url, { timeoutMs: 4000, rejectUnauthorized: false });
    return info?.cert || null;
  } catch (err) {
    logger.trace({ err, siteId: site?.id }, 'cert.side_channel_failed');
    return null;
  }
}

// Cert-only monitor: just open a TLS handshake and assert validity.
// Configurable host/port via cert_host / cert_port; falls back to URL.
async function runCertCheck(site) {
  const log = logger.child({ siteId: site.id, siteName: site.name, monitorType: 'cert' });
  const target = (site.cert_host && site.cert_port)
    ? `${site.cert_host}:${site.cert_port}`
    : (site.cert_host || site.url || '');
  if (!target) {
    return { isUp: 0, statusCode: null, responseTimeMs: null, errorMessage: 'no host configured', challenged: false, cert: null };
  }
  const start = process.hrtime.bigint();
  try {
    const info = await cert.inspect(target, {
      timeoutMs: Math.max(2000, site.timeout_ms || 10000),
      // We want to know about expired certs, so don't auto-reject; but if
      // the user really wants strict mode they can set cloudflare_mode-like
      // semantics later. For now, info is authoritative.
      rejectUnauthorized: false,
    });
    const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
    const c = info.cert;
    if (!c) {
      return { isUp: 0, statusCode: null, responseTimeMs: ms, errorMessage: 'no cert returned', challenged: false, cert: null };
    }
    if (c.days_remaining == null) {
      return { isUp: 0, statusCode: null, responseTimeMs: ms, errorMessage: 'cert missing valid_to', challenged: false, cert: c };
    }
    if (c.days_remaining < 0) {
      return { isUp: 0, statusCode: null, responseTimeMs: ms, errorMessage: `cert expired ${-c.days_remaining} days ago`, challenged: false, cert: c };
    }
    return { isUp: 1, statusCode: null, responseTimeMs: ms, errorMessage: null, challenged: false, cert: c };
  } catch (err) {
    const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
    log.debug({ err: err?.message }, 'cert.check_failed');
    return { isUp: 0, statusCode: null, responseTimeMs: ms, errorMessage: `tls: ${err?.message || err}`, challenged: false, cert: null };
  }
}

async function runTcpCheck(site) {
  const log = logger.child({ siteId: site.id, siteName: site.name, monitorType: 'tcp' });
  const host = (site.tcp_host || '').trim();
  const port = Number(site.tcp_port);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
    return { isUp: 0, statusCode: null, responseTimeMs: null, errorMessage: 'tcp: no host/port configured', challenged: false };
  }
  const res = await tcpProbe.inspect(host, port, {
    timeoutMs: Math.max(1000, site.timeout_ms || 5000),
    expectBanner: site.expected_string || '',
  });
  log.trace({ host, port, ok: res.ok, ms: res.responseTimeMs }, 'tcp.check_done');
  return {
    isUp: res.ok ? 1 : 0,
    statusCode: null,
    responseTimeMs: res.responseTimeMs,
    errorMessage: res.errorMessage,
    challenged: false,
  };
}

async function runPingCheck(site) {
  const log = logger.child({ siteId: site.id, siteName: site.name, monitorType: 'ping' });
  const host = (site.ping_host || site.tcp_host || '').trim();
  if (!host) {
    return { isUp: 0, statusCode: null, responseTimeMs: null, errorMessage: 'ping: no host configured', challenged: false };
  }
  const res = await pingProbe.inspect(host, {
    timeoutMs: Math.max(1000, site.timeout_ms || 5000),
    count: Math.max(1, Math.min(10, site.ping_count || 1)),
  });
  log.trace({ host, ok: res.ok, ms: res.responseTimeMs, lossPct: res.lossPct }, 'ping.check_done');
  return {
    isUp: res.ok ? 1 : 0,
    statusCode: null,
    responseTimeMs: res.responseTimeMs,
    errorMessage: res.errorMessage,
    challenged: false,
  };
}

async function runDnsCheck(site) {
  const log = logger.child({ siteId: site.id, siteName: site.name, monitorType: 'dns' });
  const query = (site.dns_query || '').trim();
  if (!query) {
    return { isUp: 0, statusCode: null, responseTimeMs: null, errorMessage: 'dns: no query configured', challenged: false };
  }
  const res = await dnsProbe.inspect(query, {
    timeoutMs: Math.max(1000, site.timeout_ms || 5000),
    recordType: site.dns_record_type || 'A',
    resolver: site.dns_resolver || '',
    expected: site.dns_expected || '',
  });
  log.trace({ query, ok: res.ok, records: res.records?.length }, 'dns.check_done');
  return {
    isUp: res.ok ? 1 : 0,
    statusCode: null,
    responseTimeMs: res.responseTimeMs,
    errorMessage: res.errorMessage,
    challenged: false,
  };
}

// Domain expiry monitor (WHOIS / RDAP).
// State semantics (deliberately different from typical probes):
//   - lookup fails / unreachable     → isUp: null (inconclusive, not 'down')
//   - lookup succeeds, expiry parsed → isUp: 1 (up) or 0 if already expired
//   - lookup succeeds, expiry redacted by registry → isUp: null (unknown)
// The "domain expiring within warn_days" alert is fired by the monitor
// processResult path via persistDomainInfo, not here.
async function runDomainCheck(site) {
  const log = logger.child({ siteId: site.id, siteName: site.name, monitorType: 'domain' });
  const domain = (site.whois_domain || '').trim();
  if (!domain) {
    return { isUp: 0, statusCode: null, responseTimeMs: null, errorMessage: 'no domain configured', challenged: false, domain: null };
  }
  const timeoutMs = Math.max(3000, site.timeout_ms || 12000);
  try {
    const info = await whois.inspect(domain, { timeoutMs });
    log.trace({ domain, source: info.source, days: info.days_remaining }, 'whois.check_done');
    if (!info.ok) {
      // RDAP-authoritative "domain not found" → down (clear outage signal).
      return {
        isUp: 0,
        statusCode: null,
        responseTimeMs: info.response_time_ms || null,
        errorMessage: info.error || 'domain lookup failed',
        challenged: false,
        domain: null,
      };
    }
    if (info.days_remaining == null) {
      // Lookup worked, but registry redacted expiry — stay 'unknown', don't
      // overwrite stale-but-correct data, don't flip the user's monitor red.
      return {
        isUp: null,
        statusCode: null,
        responseTimeMs: info.response_time_ms,
        errorMessage: 'expiry not parseable from registry response',
        challenged: false,
        domain: info,
      };
    }
    if (info.days_remaining < 0) {
      return {
        isUp: 0,
        statusCode: null,
        responseTimeMs: info.response_time_ms,
        errorMessage: `domain expired ${-info.days_remaining} days ago`,
        challenged: false,
        domain: info,
      };
    }
    return {
      isUp: 1,
      statusCode: null,
      responseTimeMs: info.response_time_ms,
      errorMessage: null,
      challenged: false,
      domain: info,
    };
  } catch (err) {
    log.debug({ err: err.message }, 'whois.check_failed');
    // Network / DNS / registry-side problems are *not* the site's fault.
    // Keep state as 'unknown' (isUp: null) rather than marking the user's
    // monitor down on every registry hiccup.
    return {
      isUp: null,
      statusCode: null,
      responseTimeMs: null,
      errorMessage: `whois: ${err?.message || err}`,
      challenged: false,
      domain: null,
    };
  }
}

async function runCheck(site) {
  const log = logger.child({ siteId: site.id, siteName: site.name });
  if (site.monitor_type === 'cert') return runCertCheck(site);
  if (site.monitor_type === 'tcp') return runTcpCheck(site);
  if (site.monitor_type === 'ping') return runPingCheck(site);
  if (site.monitor_type === 'dns') return runDnsCheck(site);
  if (site.monitor_type === 'domain') return runDomainCheck(site);
  const checkType = site.check_type || 'status';
  // HEAD probe is only valid when we don't need the response body. Any
  // assertion against the body (string / json) requires GET.
  const bodyRequired = checkType === 'string' || checkType === 'json';
  const useHead = !!site.cloudflare_mode
    && !bodyRequired
    && (site.method || 'GET').toUpperCase() === 'GET';
  const baseMethod = useHead ? 'HEAD' : (site.method || 'GET').toUpperCase();
  const timeoutMs = Math.max(1000, site.timeout_ms || 10000);
  const headers = buildHeaders(site);
  const dispatcher = dispatcherFor(site);
  // Follow redirects toggle stores 0/1; we map to 0 or 5 hops.
  const maxRedirections = site.follow_redirects ? 5 : 0;
  const bodyInfo = pickRequestBody(site);
  if (bodyInfo.body != null && bodyInfo.contentType && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = bodyInfo.contentType;
  }

  log.trace({ url: site.url, method: baseMethod, timeoutMs, hasBody: !!bodyInfo.body, skipTls: !!site.skip_tls_verify, follow: !!site.follow_redirects }, 'check.start');

  let res;
  try {
    res = await fetchWithTiming({ method: baseMethod, url: site.url, headers, timeoutMs, body: bodyInfo.body, maxRedirections, dispatcher });
    if (baseMethod === 'HEAD' && res.status === 405) {
      log.trace('check.head_not_allowed_falling_back_to_get');
      res = await fetchWithTiming({ method: 'GET', url: site.url, headers, timeoutMs, maxRedirections, dispatcher });
    }
  } catch (err) {
    const name = err?.name || err?.code || 'Error';
    const msg = err?.message || String(err);
    const errorMessage = name === 'AbortError' || msg === 'timeout' ? `timeout after ${timeoutMs}ms` : `${name}: ${msg}`;
    log.debug({ err: errorMessage }, 'check.network_failed');
    return {
      isUp: 0,
      statusCode: null,
      responseTimeMs: null,
      errorMessage,
      challenged: false,
    };
  }

  const challenge = cf.detectChallenge({ status: res.status, headers: res.headers, body: res.body });
  if (challenge.challenged) {
    log.warn({ status: res.status, reason: challenge.reason }, 'check.cloudflare_challenge');
    return {
      isUp: null,
      statusCode: res.status,
      responseTimeMs: res.responseTimeMs,
      errorMessage: `cloudflare:${challenge.reason}`,
      challenged: true,
    };
  }

  let pass = false;
  let why = '';

  if (checkType === 'status') {
    const expected = parseExpectedStatus(site.expected_status);
    pass = expected.includes(res.status);
    if (!pass) why = `status ${res.status} not in [${expected.join(',')}]`;
  } else if (checkType === 'string') {
    if (res.status >= 400) {
      pass = false;
      why = `http ${res.status} (string check)`;
    } else {
      pass = res.body.includes(site.expected_string || '');
      if (!pass) why = `body did not contain expected string`;
    }
  } else if (checkType === 'regex') {
    if (res.status >= 400) {
      pass = false;
      why = `http ${res.status} (regex check)`;
    } else {
      const raw = String(site.expected_string || '').trim();
      try {
        // Accept either /pattern/flags or a bare pattern (default flags=i).
        const m = raw.match(/^\/(.+)\/([gimsuy]*)$/);
        const re = m ? new RegExp(m[1], m[2]) : new RegExp(raw, 'i');
        pass = re.test(res.body);
        if (!pass) why = `body did not match regex /${m ? m[1] : raw}/${m ? m[2] : 'i'}`;
      } catch (e) {
        pass = false;
        why = `invalid regex: ${e.message}`;
      }
    }
  } else if (checkType === 'json') {
    if (res.status >= 400) {
      pass = false;
      why = `http ${res.status} (json check)`;
    } else {
      try {
        const parsed = JSON.parse(res.body);
        const got = getJsonPath(parsed, site.json_path);
        const exp = site.expected_json_value;
        pass = String(got) === String(exp);
        if (!pass) why = `json path "${site.json_path}" was "${got}", expected "${exp}"`;
      } catch (e) {
        pass = false;
        why = `invalid json body: ${e.message}`;
      }
    }
  }

  // Response-time threshold — applied after the primary assertion passes so
  // the reason gets surfaced consistently even if the underlying check was OK.
  if (pass && site.max_response_time_ms && Number.isFinite(site.max_response_time_ms)) {
    if (res.responseTimeMs > site.max_response_time_ms) {
      pass = false;
      why = `response too slow: ${res.responseTimeMs}ms > ${site.max_response_time_ms}ms`;
    }
  }

  log.trace(
    { status: res.status, responseTimeMs: res.responseTimeMs, pass, why: pass ? undefined : why },
    'check.evaluated'
  );

  // Best-effort: capture cert info for HTTPS probes so the dashboard can
  // surface expiry data even for plain status / string / json monitors.
  // We don't fail the check on TLS issues here — that's what the dedicated
  // cert monitor type is for.
  let certInfo = null;
  if (pass && /^https:\/\//i.test(site.url || '')) {
    certInfo = await captureCertSideChannel(site);
  }

  return {
    isUp: pass ? 1 : 0,
    statusCode: res.status,
    responseTimeMs: res.responseTimeMs,
    errorMessage: pass ? null : why,
    challenged: false,
    cert: certInfo,
  };
}

async function evaluateHeartbeat(site) {
  const db = require('../db');
  const rows = await db.query(
    `SELECT ${db.diffSecondsSql('last_heartbeat_at', db.nowMs())} AS age_seconds
       FROM sites WHERE id = ?`,
    [site.id]
  );
  const ageSec = rows[0]?.age_seconds;
  if (ageSec == null) {
    return {
      isUp: 0,
      statusCode: null,
      responseTimeMs: null,
      errorMessage: 'never received a heartbeat',
      challenged: false,
    };
  }

  let tolerated;
  if (site.heartbeat_schedule_kind === 'cron' && site.heartbeat_cron) {
    // For cron schedules we accept any ping up to (next expected ping +
    // grace). The "next expected" is the next occurrence of the cron
    // counted from the last ping, so a late ping is still tolerated until
    // the next slot lapses.
    try {
      const cronParser = require('cron-parser');
      const tz = site.heartbeat_timezone || 'UTC';
      const ref = new Date(Date.now() - ageSec * 1000);
      const it = cronParser.CronExpressionParser.parse(site.heartbeat_cron, { currentDate: ref, tz });
      const nextDue = it.next().toDate();
      const slack = Math.max(0, site.heartbeat_grace_seconds || 60);
      const cutoff = nextDue.getTime() + slack * 1000;
      tolerated = Math.max(60, Math.floor((cutoff - (Date.now() - ageSec * 1000)) / 1000));
      if (Date.now() > cutoff) {
        return {
          isUp: 0,
          statusCode: null,
          responseTimeMs: null,
          errorMessage: `no heartbeat for ${ageSec}s (cron "${site.heartbeat_cron}" missed, due by ${nextDue.toISOString()} + ${slack}s)`,
          challenged: false,
        };
      }
    } catch (err) {
      tolerated = (site.interval_seconds || 60) + (site.heartbeat_grace_seconds || 60);
    }
  } else {
    tolerated = (site.interval_seconds || 60) + (site.heartbeat_grace_seconds || 60);
  }

  if (ageSec > tolerated) {
    return {
      isUp: 0,
      statusCode: null,
      responseTimeMs: null,
      errorMessage: `no heartbeat for ${ageSec}s (tolerated ${tolerated}s)`,
      challenged: false,
    };
  }
  // If the last terminal ping was an explicit failure, keep the monitor down
  // until a new success arrives — regardless of recency.
  if (site.last_heartbeat_kind === 'failure') {
    return {
      isUp: 0,
      statusCode: null,
      responseTimeMs: null,
      errorMessage: `last heartbeat reported failure${site.last_heartbeat_exit_code != null ? ` (exit ${site.last_heartbeat_exit_code})` : ''}`,
      challenged: false,
    };
  }
  return {
    isUp: 1,
    statusCode: null,
    responseTimeMs: null,
    errorMessage: null,
    challenged: false,
  };
}

module.exports = {
  runCheck,
  runCertCheck,
  runDomainCheck,
  runTcpCheck,
  runPingCheck,
  runDnsCheck,
  evaluateHeartbeat,
  sharedAgent,
  captureCertSideChannel,
};
