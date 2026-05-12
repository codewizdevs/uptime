'use strict';

// Minimal TCP probe: open a connection, optionally wait for the server to
// send a banner (so SMTP/SSH/IMAP banner-checks work), and return timing.
// We treat *any* successful 3-way handshake as success unless the caller
// supplies an `expectBanner` substring.

const net = require('net');

function inspect(host, port, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(500, options.timeoutMs || 5000);
    const expectBanner = (options.expectBanner || '').trim();
    const start = process.hrtime.bigint();
    let settled = false;
    let banner = '';

    const socket = new net.Socket();
    socket.setNoDelay(true);
    socket.setTimeout(timeoutMs);

    const finish = (errMsg) => {
      if (settled) return;
      settled = true;
      const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({
        ok: !errMsg,
        responseTimeMs: ms,
        errorMessage: errMsg || null,
        banner: banner.slice(0, 256),
      });
    };

    socket.on('connect', () => {
      if (!expectBanner) return finish(null);
      // Wait briefly for the server's banner before declaring success.
    });

    socket.on('data', (buf) => {
      banner += buf.toString('utf8');
      if (banner.length > 4096) banner = banner.slice(0, 4096);
      if (expectBanner && banner.includes(expectBanner)) return finish(null);
    });

    socket.on('timeout', () => {
      if (socket.connecting) return finish(`tcp: timeout after ${timeoutMs}ms`);
      if (expectBanner && !banner.includes(expectBanner)) {
        return finish(`tcp: banner timeout (got "${banner.slice(0, 64).replace(/\s+/g, ' ')}…")`);
      }
      return finish(null);
    });

    socket.on('error', (err) => finish(`tcp: ${err?.code || err?.message || 'error'}`));
    socket.on('close', () => {
      if (!expectBanner) return finish(null);
      if (banner.includes(expectBanner)) return finish(null);
      return finish(`tcp: closed without banner "${expectBanner}"`);
    });

    try {
      socket.connect(port, host);
    } catch (err) {
      finish(`tcp: ${err?.message || err}`);
    }
  });
}

module.exports = { inspect };
