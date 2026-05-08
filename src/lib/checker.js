'use strict';

const zlib = require('zlib');
const { promisify } = require('util');
const { Agent, request } = require('undici');
const cf = require('./cloudflare');
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
  return headers;
}

async function fetchWithTiming({ method, url, headers, timeoutMs }) {
  const start = process.hrtime.bigint();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await request(url, {
      method,
      headers,
      dispatcher: sharedAgent,
      signal: ac.signal,
      maxRedirections: 5,
    });
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

async function runCheck(site) {
  const log = logger.child({ siteId: site.id, siteName: site.name });
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

  log.trace({ url: site.url, method: baseMethod, timeoutMs }, 'check.start');

  let res;
  try {
    res = await fetchWithTiming({ method: baseMethod, url: site.url, headers, timeoutMs });
    if (baseMethod === 'HEAD' && res.status === 405) {
      log.trace('check.head_not_allowed_falling_back_to_get');
      res = await fetchWithTiming({ method: 'GET', url: site.url, headers, timeoutMs });
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

  log.trace(
    { status: res.status, responseTimeMs: res.responseTimeMs, pass, why: pass ? undefined : why },
    'check.evaluated'
  );

  return {
    isUp: pass ? 1 : 0,
    statusCode: res.status,
    responseTimeMs: res.responseTimeMs,
    errorMessage: pass ? null : why,
    challenged: false,
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
  const tolerated = (site.interval_seconds || 60) + (site.heartbeat_grace_seconds || 60);
  if (ageSec > tolerated) {
    return {
      isUp: 0,
      statusCode: null,
      responseTimeMs: null,
      errorMessage: `no heartbeat for ${ageSec}s (tolerated ${tolerated}s)`,
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

module.exports = { runCheck, evaluateHeartbeat, sharedAgent };
