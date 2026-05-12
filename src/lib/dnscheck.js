'use strict';

// DNS monitor: looks up a record and optionally asserts a substring/regex
// match against the joined RRset. Supports A, AAAA, CNAME, MX, TXT, NS,
// SRV, CAA, SOA, PTR. Uses the built-in `dns.promises.Resolver`, with an
// optional custom resolver (host or host:port).

const dns = require('dns').promises;

const VALID_TYPES = new Set([
  'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'SOA', 'PTR',
]);

function normalizeType(t) {
  const v = String(t || 'A').trim().toUpperCase();
  return VALID_TYPES.has(v) ? v : 'A';
}

function flattenAnswer(type, answer) {
  if (!answer) return [];
  if (!Array.isArray(answer)) return [String(answer)];
  if (type === 'MX') return answer.map((r) => `${r.priority} ${r.exchange}`);
  if (type === 'TXT') return answer.map((r) => Array.isArray(r) ? r.join('') : String(r));
  if (type === 'SRV') return answer.map((r) => `${r.priority} ${r.weight} ${r.port} ${r.name}`);
  if (type === 'CAA') return answer.map((r) => `${r.critical} ${r.issue || r.issuewild || r.iodef || ''}`.trim());
  if (type === 'SOA') {
    const r = answer; return [`${r.nsname} ${r.hostmaster} ${r.serial}`];
  }
  return answer.map((r) => (r && typeof r === 'object') ? JSON.stringify(r) : String(r));
}

async function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label || 'dns'}: timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function expectedMatches(expected, joined) {
  if (!expected) return { ok: true };
  const raw = String(expected).trim();
  // /…/flags means regex; otherwise plain substring (case-insensitive).
  const m = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  try {
    if (m) {
      const re = new RegExp(m[1], m[2]);
      return re.test(joined) ? { ok: true } : { ok: false, why: `dns: no match for /${m[1]}/${m[2]}` };
    }
  } catch (e) {
    return { ok: false, why: `dns: invalid regex (${e.message})` };
  }
  return joined.toLowerCase().includes(raw.toLowerCase())
    ? { ok: true }
    : { ok: false, why: `dns: expected "${raw}" not found` };
}

async function inspect(query, options = {}) {
  const type = normalizeType(options.recordType);
  const timeoutMs = Math.max(500, options.timeoutMs || 5000);
  const expected = options.expected;
  const resolverHost = (options.resolver || '').trim();

  const start = process.hrtime.bigint();
  let resolver = dns;
  if (resolverHost) {
    // Accept "1.1.1.1", "1.1.1.1:53", "[::1]:53", or bare hostnames.
    const r = new (require('dns').promises.Resolver)({ timeout: timeoutMs, tries: 1 });
    let serverEntry = resolverHost;
    if (/^\[?[0-9a-f:.]+\]?:\d+$/.test(resolverHost) === false && /^[0-9a-f:.]+$/i.test(resolverHost)) {
      serverEntry = `${resolverHost}:53`;
    }
    try {
      r.setServers([serverEntry]);
    } catch (e) {
      return {
        ok: false,
        responseTimeMs: 0,
        errorMessage: `dns: bad resolver "${resolverHost}" (${e.message})`,
        records: [],
      };
    }
    resolver = r;
  }

  try {
    let answer;
    if (type === 'A') answer = await withTimeout(resolver.resolve4(query), timeoutMs, 'dns');
    else if (type === 'AAAA') answer = await withTimeout(resolver.resolve6(query), timeoutMs, 'dns');
    else if (type === 'PTR') answer = await withTimeout(resolver.reverse(query), timeoutMs, 'dns');
    else if (type === 'SOA') answer = await withTimeout(resolver.resolveSoa(query), timeoutMs, 'dns');
    else answer = await withTimeout(resolver.resolve(query, type), timeoutMs, 'dns');

    const records = flattenAnswer(type, answer);
    const joined = records.join('\n');
    const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);

    if (!records.length) {
      return { ok: false, responseTimeMs: ms, errorMessage: `dns: empty ${type} answer`, records };
    }
    const m = expectedMatches(expected, joined);
    if (!m.ok) return { ok: false, responseTimeMs: ms, errorMessage: m.why, records };
    return { ok: true, responseTimeMs: ms, errorMessage: null, records };
  } catch (err) {
    const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
    const code = err?.code || err?.errno || '';
    const msg = err?.message?.split('\n')[0] || String(err);
    return { ok: false, responseTimeMs: ms, errorMessage: `dns: ${code || msg}`, records: [] };
  }
}

module.exports = { inspect, VALID_TYPES: [...VALID_TYPES] };
