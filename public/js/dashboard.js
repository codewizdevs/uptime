(function () {
  const filterForm = document.getElementById('dashboard-filters');
  if (filterForm) {
    const qInput = filterForm.querySelector('#filter-q');

    let debounceTimer = null;
    function submitSoon(immediate) {
      clearTimeout(debounceTimer);
      const delay = immediate ? 0 : 350;
      debounceTimer = setTimeout(function () {
        const params = new URLSearchParams(new FormData(filterForm));
        for (const [k, v] of Array.from(params.entries())) {
          if (v === '' || v == null) params.delete(k);
        }
        const qs = params.toString();
        window.location.href = '/' + (qs ? '?' + qs : '');
      }, delay);
    }

    if (qInput) {
      qInput.addEventListener('input', function () { submitSoon(false); });
      qInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitSoon(true); }
      });
    }

    filterForm.querySelectorAll('.filter-pills').forEach(function (group) {
      const groupName = group.getAttribute('data-filter-group');
      const hidden = filterForm.querySelector('#filter-' + groupName);
      group.querySelectorAll('.filter-pill').forEach(function (pill) {
        pill.addEventListener('click', function (e) {
          e.preventDefault();
          const value = pill.getAttribute('data-value') || '';
          if (hidden) hidden.value = value;
          group.querySelectorAll('.filter-pill').forEach(function (p) { p.classList.remove('is-active'); });
          pill.classList.add('is-active');
          submitSoon(true);
        });
      });
    });
  }

  const container = document.getElementById('site-cards');
  if (!container) return;

  const confirmModal = document.getElementById('confirm-delete-card');
  const confirmName = document.getElementById('confirm-delete-name');
  const confirmForm = document.getElementById('confirm-delete-form');
  if (confirmModal && confirmName && confirmForm) {
    container.addEventListener('click', function (e) {
      const btn = e.target.closest('.site-card-delete');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-site-id');
      const name = btn.getAttribute('data-site-name') || 'this monitor';
      if (!id) return;
      confirmName.textContent = name;
      confirmForm.setAttribute('action', '/sites/' + encodeURIComponent(id) + '/delete');
      confirmModal.classList.add('show');
      document.body.classList.add('modal-open');
    });
  }

  function relativeTime(iso) {
    if (!iso) return 'never';
    const t = new Date(iso).getTime();
    if (!t) return iso;
    const diff = Math.floor((Date.now() - t) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function visibleIds() {
    const ids = [];
    container.querySelectorAll('[data-site-id]').forEach(function (el) {
      const v = parseInt(el.getAttribute('data-site-id'), 10);
      if (Number.isFinite(v)) ids.push(v);
    });
    return ids;
  }

  function colorFor(state) {
    return ({ up: 'success', down: 'danger', paused: 'secondary', unknown: 'muted' })[state] || 'muted';
  }

  function setText(el, iconClass, text) {
    if (!el) return;
    el.innerHTML = '';
    if (iconClass) {
      const i = document.createElement('i');
      i.className = 'ti ' + iconClass;
      el.appendChild(i);
      el.appendChild(document.createTextNode(' '));
    }
    el.appendChild(document.createTextNode(text));
  }

  function setRt(el, value) {
    if (!el) return;
    el.innerHTML = '';
    el.appendChild(document.createTextNode(String(value)));
    const unit = document.createElement('span');
    unit.className = 'stat-unit';
    unit.textContent = 'ms';
    el.appendChild(unit);
  }

  async function tick() {
    try {
      const ids = visibleIds();
      if (!ids.length) return;
      const url = '/api/sites?ids=' + encodeURIComponent(ids.join(','));
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      data.forEach(function (s) {
        const card = container.querySelector('[data-site-id="' + s.id + '"]');
        if (!card) return;
        const dot = card.querySelector('[data-role="dot"]');
        const lastCheckedEl = card.querySelector('[data-role="last-checked"]');
        const lastRtEl = card.querySelector('[data-role="last-rt"]');
        const stripe = card.querySelector('.card-status-start');
        const color = colorFor(s.state);
        if (dot) dot.className = 'status-dot status-dot-animated bg-' + color;
        if (stripe) stripe.className = 'card-status-start bg-' + color;
        if (lastCheckedEl) {
          if (s.monitor_type === 'heartbeat') {
            setText(lastCheckedEl, 'ti-clock', s.last_heartbeat_at ? 'last ping ' + relativeTime(s.last_heartbeat_at) : 'no pings yet');
          } else if (s.last_check) {
            setText(lastCheckedEl, 'ti-clock', relativeTime(s.last_check.checked_at));
          } else {
            setText(lastCheckedEl, 'ti-clock', 'no checks yet');
          }
        }
        if (lastRtEl && s.last_check && s.last_check.response_time_ms != null) {
          setRt(lastRtEl, s.last_check.response_time_ms);
        }
      });
    } catch (e) {}
  }

  tick();
  setInterval(tick, 5000);
})();
