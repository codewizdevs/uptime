'use strict';

const { formatDuration } = require('./format');

function buildVars(event, site, payload = {}) {
  const now = new Date();
  return {
    event,
    site_id: site?.id ?? '',
    site_name: site?.name ?? '',
    site_url: site?.url ?? '',
    monitor_type: site?.monitor_type ?? 'active',
    state:
      event === 'down'
        ? 'down'
        : event === 'recovered'
        ? 'up'
        : event === 'challenged'
        ? 'challenged'
        : 'test',
    error: payload.error ?? '',
    status_code: payload.status_code ?? '',
    response_time_ms: payload.response_time_ms ?? '',
    duration_seconds: payload.duration_seconds ?? '',
    duration_human: payload.duration_seconds != null ? formatDuration(Number(payload.duration_seconds)) : '',
    streak: payload.streak ?? '',
    timestamp: now.toISOString(),
    timestamp_human: now.toLocaleString(),
  };
}

function sampleVars() {
  return buildVars('test', { id: 0, name: 'Sample monitor', url: 'https://example.com', monitor_type: 'active' }, {
    error: 'this is only a test',
    status_code: 503,
    response_time_ms: 120,
    duration_seconds: 75,
  });
}

function render(template, vars) {
  if (template == null) return '';
  return String(template).replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const v = vars[key];
      return v == null ? '' : String(v);
    }
    return '';
  });
}

function renderJson(template, vars) {
  const rendered = render(template, vars);
  try {
    return { ok: true, value: JSON.parse(rendered), text: rendered };
  } catch (e) {
    return { ok: false, error: e.message, text: rendered };
  }
}

module.exports = { buildVars, sampleVars, render, renderJson };
