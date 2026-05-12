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

  // On submit, mirror the value of every [data-mirror="targetName"] input
  // inside the *currently visible* section into the hidden canonical
  // form-field of that name. This lets each monitor_type have its own UI
  // copy of shared fields (interval_seconds, failure_threshold, …).
  //
  // We also respect [data-check] wrappers so e.g. the regex-flavour input
  // for the body assertion only writes through when its check_type tab is
  // actually visible.
  form.addEventListener('submit', function () {
    if (!monitorType) return;
    form.querySelectorAll('[data-mirror]').forEach(function (input) {
      var section = input.closest('[data-section]');
      if (section && section.hidden) return;
      var check = input.closest('[data-check]');
      if (check && check.hidden) return;
      var name = input.getAttribute('data-mirror');
      var target = form.querySelector('[name="' + name + '"]:not([data-mirror])');
      if (target) target.value = input.value;
    });
  });
})();
