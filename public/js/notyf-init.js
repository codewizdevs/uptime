(function () {
  if (typeof Notyf === 'undefined') return;
  const notyf = new Notyf({
    duration: 4000,
    ripple: true,
    dismissible: true,
    position: { x: 'right', y: 'top' },
    types: [
      { type: 'success', background: '#2fb344', icon: { className: 'ti ti-check', tagName: 'i', color: '#fff' } },
      { type: 'error',   background: '#d6336c', icon: { className: 'ti ti-x',     tagName: 'i', color: '#fff' } },
      { type: 'warning', background: '#f59f00', icon: { className: 'ti ti-alert-triangle', tagName: 'i', color: '#fff' } },
    ],
  });
  window.notyf = notyf;

  const f = window.__flash || {};
  (f.success || []).forEach(function (msg) { notyf.success(String(msg)); });
  (f.error   || []).forEach(function (msg) { notyf.error(String(msg)); });
  (f.warning || []).forEach(function (msg) { notyf.open({ type: 'warning', message: String(msg) }); });
})();
