(function () {
  function closeAll(except) {
    document.querySelectorAll('.dropdown-menu.show').forEach(function (m) {
      if (m !== except) {
        m.classList.remove('show');
        const trigger = document.querySelector('[data-dropdown-toggle="#' + m.id + '"]');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
      }
    });
  }

  document.addEventListener('click', function (e) {
    const trigger = e.target.closest('[data-dropdown-toggle]');
    if (trigger) {
      e.preventDefault();
      e.stopPropagation();
      const sel = trigger.getAttribute('data-dropdown-toggle');
      const menu = document.querySelector(sel);
      if (!menu) return;
      const isOpen = menu.classList.contains('show');
      closeAll(menu);
      menu.classList.toggle('show', !isOpen);
      trigger.setAttribute('aria-expanded', String(!isOpen));
      return;
    }
    if (e.target.closest('.dropdown-menu')) return;
    closeAll();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAll();
  });
})();
