'use strict';

// ICMP ping by shelling out to /bin/ping. We don't use raw sockets because
// that requires CAP_NET_RAW. The OS ping binary is widely available and
// usually runs unprivileged via setuid or net.ipv4.ping_group_range.

const { execFile } = require('child_process');

const PING_BINARIES = ['/usr/bin/ping', '/bin/ping', 'ping'];

function resolveBinary() {
  // Try absolute paths first, then fall back to PATH lookup.
  for (const p of PING_BINARIES) {
    if (p.startsWith('/')) {
      try {
        // eslint-disable-next-line global-require
        require('fs').accessSync(p);
        return p;
      } catch { /* keep looking */ }
    }
  }
  return 'ping';
}

const PING_BIN = resolveBinary();

// Output parsers — work for iputils ping (Linux), busybox ping, and macOS.
const RX_LOSS = /(\d+(?:\.\d+)?)%\s*packet\s*loss/i;
const RX_RTT_LINE = /(?:rtt|round-trip)\s+min\/avg\/max(?:\/(?:mdev|stddev))?\s*=\s*([0-9.]+)\/([0-9.]+)\/([0-9.]+)/i;
const RX_TIME = /time[=<]\s*([0-9.]+)\s*ms/i;

function inspect(host, options = {}) {
  return new Promise((resolve) => {
    const timeoutSec = Math.max(1, Math.ceil((options.timeoutMs || 5000) / 1000));
    const count = Math.max(1, Math.min(10, options.count || 1));
    const args = ['-n', '-c', String(count), '-W', String(timeoutSec), host];

    execFile(PING_BIN, args, { timeout: timeoutSec * 1000 * (count + 1) }, (err, stdout, stderr) => {
      const text = `${stdout || ''}\n${stderr || ''}`;
      const lossMatch = text.match(RX_LOSS);
      const rttMatch = text.match(RX_RTT_LINE);
      const singleTime = text.match(RX_TIME);
      const lossPct = lossMatch ? Number(lossMatch[1]) : 100;
      let avgMs = null;
      if (rttMatch) avgMs = Number(rttMatch[2]);
      else if (singleTime) avgMs = Number(singleTime[1]);

      if (err && lossPct === 100) {
        const msg = (err.code === 'ENOENT')
          ? 'ping: binary not found on host'
          : `ping: ${err.message?.split('\n')[0] || 'failed'}`;
        return resolve({ ok: false, responseTimeMs: null, errorMessage: msg, lossPct });
      }
      if (lossPct >= 100) {
        return resolve({ ok: false, responseTimeMs: null, errorMessage: 'ping: 100% packet loss', lossPct });
      }
      if (lossPct > 0) {
        return resolve({
          ok: true,
          responseTimeMs: avgMs == null ? null : Math.round(avgMs),
          errorMessage: null,
          lossPct,
          partial: `ping: ${lossPct}% packet loss`,
        });
      }
      return resolve({
        ok: true,
        responseTimeMs: avgMs == null ? null : Math.round(avgMs),
        errorMessage: null,
        lossPct: 0,
      });
    });
  });
}

module.exports = { inspect };
