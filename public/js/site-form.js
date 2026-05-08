(function () {
  const monitorType = document.getElementById('monitor_type');
  const checkType = document.getElementById('check_type');
  const form = document.getElementById('site-form');
  if (!form) return;

  function syncSection() {
    const v = monitorType.value;
    document.querySelectorAll('[data-section]').forEach(function (el) {
      el.hidden = el.getAttribute('data-section') !== v;
    });
  }

  function syncCheckType() {
    if (!checkType) return;
    const v = checkType.value;
    document.querySelectorAll('[data-check]').forEach(function (el) {
      el.hidden = el.getAttribute('data-check') !== v;
    });
  }

  if (monitorType) {
    monitorType.addEventListener('change', syncSection);
    syncSection();
  }
  if (checkType) {
    checkType.addEventListener('change', syncCheckType);
    syncCheckType();
  }

  form.addEventListener('submit', function () {
    if (!monitorType) return;
    if (monitorType.value === 'heartbeat') {
      const hb = form.querySelector('input[name="interval_seconds_hb"]');
      const fr = form.querySelector('input[name="failure_threshold_hb"]');
      const real = form.querySelector('input[name="interval_seconds"]');
      const realFr = form.querySelector('input[name="failure_threshold"]');
      if (hb && real) real.value = hb.value;
      if (fr && realFr) realFr.value = fr.value;
    }
  });
})();
