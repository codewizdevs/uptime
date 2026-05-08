'use strict';

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '';
  const s = Math.max(0, Math.floor(Number(seconds)));
  if (s < 1) return 'less than a second';
  const days = Math.floor(s / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hrs) parts.push(`${hrs}h`);
  if (mins) parts.push(`${mins}m`);
  if (secs && !days) parts.push(`${secs}s`);
  return parts.join(' ') || `${secs}s`;
}

module.exports = { formatDuration };
