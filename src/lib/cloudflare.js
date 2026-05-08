'use strict';

const USER_AGENT_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];

function pickUserAgent(siteId) {
  const idx = ((Number(siteId) || 0) * 2654435761) >>> 0;
  return USER_AGENT_POOL[idx % USER_AGENT_POOL.length];
}

const DEFAULT_BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

const CHALLENGE_BODY_MARKERS = [
  '__cf_chl_',
  'cf-chl-bypass',
  'cf-browser-verification',
  'challenge-platform',
  'Just a moment',
  'Checking your browser',
  '/cdn-cgi/challenge-platform/',
];

function detectChallenge({ status, headers, body }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers || {})) lower[k.toLowerCase()] = String(v);

  if (lower['cf-mitigated']) {
    return { challenged: true, reason: `cf-mitigated:${lower['cf-mitigated']}` };
  }

  const isCloudflare = lower['server'] === 'cloudflare' || !!lower['cf-ray'];
  if (!isCloudflare) return { challenged: false };

  if ((status === 403 || status === 503) && body) {
    for (const marker of CHALLENGE_BODY_MARKERS) {
      if (body.includes(marker)) {
        return { challenged: true, reason: `cf-body-marker:${marker}:${status}` };
      }
    }
  }

  if (status === 1010 || status === 1020 || status === 1015) {
    return { challenged: true, reason: `cf-error:${status}` };
  }

  return { challenged: false };
}

const MIN_CF_INTERVAL = 60;
const MAX_CF_BACKOFF = 30 * 60;

function nextBackoff(currentSeconds, baseSeconds) {
  const doubled = Math.max(baseSeconds, currentSeconds) * 2;
  return Math.min(MAX_CF_BACKOFF, doubled);
}

function applyJitter(seconds, ratio = 0.05) {
  const delta = seconds * ratio;
  return Math.max(1, Math.round(seconds + (Math.random() * 2 - 1) * delta));
}

module.exports = {
  USER_AGENT_POOL,
  DEFAULT_BROWSER_HEADERS,
  pickUserAgent,
  detectChallenge,
  nextBackoff,
  applyJitter,
  MIN_CF_INTERVAL,
  MAX_CF_BACKOFF,
};
