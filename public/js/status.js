(function () {
  'use strict';

  function humanize(deltaSec) {
    if (deltaSec < 60) return Math.floor(deltaSec) + 's ago';
    if (deltaSec < 3600) return Math.floor(deltaSec / 60) + 'm ago';
    if (deltaSec < 86400) return Math.floor(deltaSec / 3600) + 'h ago';
    return Math.floor(deltaSec / 86400) + 'd ago';
  }

  function refreshRelative() {
    var now = Date.now();
    document.querySelectorAll('[data-relative-time]').forEach(function (el) {
      var ts = el.getAttribute('data-relative-time');
      var t = ts ? Date.parse(ts) : NaN;
      if (!Number.isFinite(t)) return;
      var delta = (now - t) / 1000;
      if (delta < 0) delta = 0;
      el.textContent = humanize(delta);
    });
  }

  refreshRelative();
  setInterval(refreshRelative, 30000);
  // Auto-refresh the whole page every 60s so server-side state is current.
  setInterval(function () { window.location.reload(); }, 60000);
})();
