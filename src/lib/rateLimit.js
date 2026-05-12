'use strict';

// Lightweight in-memory rate limiter / lockout for the login flow.
// No Redis or external deps — fits the project's single-process MIT promise.
//
// Two complementary buckets:
//   ipBucket   — keyed by client IP   (5 failures / 15 min → temp block)
//   userBucket — keyed by username    (10 failures / 30 min → temp block)
//
// Each bucket tracks an array of failure timestamps; a successful login
// clears the bucket for that key. Buckets expire on read.

const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_FAILS = 5;
const IP_LOCK_MS   = 15 * 60 * 1000;

const USER_WINDOW_MS = 30 * 60 * 1000;
const USER_MAX_FAILS = 10;
const USER_LOCK_MS   = 30 * 60 * 1000;

const ipBucket = new Map();
const userBucket = new Map();

function now() { return Date.now(); }

function pruneAndCount(bucket, key, windowMs) {
  const entry = bucket.get(key);
  if (!entry) return { fails: 0, lockedUntil: 0 };
  const t = now();
  entry.times = entry.times.filter((ts) => t - ts < windowMs);
  if (!entry.times.length && t > (entry.lockedUntil || 0)) {
    bucket.delete(key);
    return { fails: 0, lockedUntil: 0 };
  }
  return { fails: entry.times.length, lockedUntil: entry.lockedUntil || 0 };
}

function getLockMessage(ipStatus, userStatus) {
  const t = now();
  const remaining = Math.max(ipStatus.lockedUntil, userStatus.lockedUntil) - t;
  if (remaining <= 0) return null;
  const mins = Math.ceil(remaining / 60000);
  return `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
}

function checkLocked(ip, username) {
  const ipStatus = pruneAndCount(ipBucket, ip || 'unknown', IP_WINDOW_MS);
  const userStatus = pruneAndCount(userBucket, (username || '').toLowerCase(), USER_WINDOW_MS);
  return getLockMessage(ipStatus, userStatus);
}

function recordFailure(ip, username) {
  const t = now();
  const ipKey = ip || 'unknown';
  const userKey = (username || '').toLowerCase();

  const ipEntry = ipBucket.get(ipKey) || { times: [], lockedUntil: 0 };
  ipEntry.times = ipEntry.times.filter((ts) => t - ts < IP_WINDOW_MS);
  ipEntry.times.push(t);
  if (ipEntry.times.length >= IP_MAX_FAILS) ipEntry.lockedUntil = t + IP_LOCK_MS;
  ipBucket.set(ipKey, ipEntry);

  if (userKey) {
    const uEntry = userBucket.get(userKey) || { times: [], lockedUntil: 0 };
    uEntry.times = uEntry.times.filter((ts) => t - ts < USER_WINDOW_MS);
    uEntry.times.push(t);
    if (uEntry.times.length >= USER_MAX_FAILS) uEntry.lockedUntil = t + USER_LOCK_MS;
    userBucket.set(userKey, uEntry);
  }
}

function recordSuccess(ip, username) {
  ipBucket.delete(ip || 'unknown');
  userBucket.delete((username || '').toLowerCase());
}

function stats() {
  return {
    ip_keys: ipBucket.size,
    user_keys: userBucket.size,
  };
}

module.exports = {
  checkLocked,
  recordFailure,
  recordSuccess,
  stats,
  IP_MAX_FAILS,
  USER_MAX_FAILS,
};
