(function () {
  let lastFocusedTemplate = null;

  document.querySelectorAll('.template-input').forEach(function (el) {
    el.addEventListener('focus', function () { lastFocusedTemplate = el; });
  });

  function insertAtCursor(input, text) {
    if (input == null) return;
    const start = input.selectionStart != null ? input.selectionStart : input.value.length;
    const end = input.selectionEnd != null ? input.selectionEnd : input.value.length;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    input.value = before + text + after;
    const pos = start + text.length;
    if (input.setSelectionRange) input.setSelectionRange(pos, pos);
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  document.querySelectorAll('.placeholder-chip').forEach(function (chip) {
    chip.addEventListener('click', function (e) {
      e.preventDefault();
      const text = chip.getAttribute('data-placeholder');
      let target = lastFocusedTemplate;
      if (!target || !document.body.contains(target)) {
        const visible = Array.from(document.querySelectorAll('details.template-event[open] .template-input'));
        target = visible[visible.length - 1] || document.querySelector('.template-input');
      }
      if (target) {
        const det = target.closest('details.template-event');
        if (det && !det.open) det.open = true;
        insertAtCursor(target, text);
      }
    });
  });

  document.querySelectorAll('.reset-default').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      const targetId = btn.getAttribute('data-target');
      const def = btn.getAttribute('data-default') || '';
      const el = document.getElementById(targetId);
      if (!el) return;
      el.value = def;
      el.focus();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (window.notyf) window.notyf.success('Reset to default');
    });
  });
})();
