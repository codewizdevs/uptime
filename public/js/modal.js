(function () {
  function open(modal) {
    modal.classList.add('show');
    document.body.classList.add('modal-open');
  }
  function close(modal) {
    modal.classList.remove('show');
    document.body.classList.remove('modal-open');
  }

  document.addEventListener('click', function (e) {
    const opener = e.target.closest('[data-modal-open]');
    if (opener) {
      e.preventDefault();
      const sel = opener.getAttribute('data-modal-open');
      const modal = document.querySelector(sel);
      if (modal) open(modal);
      return;
    }
    const closer = e.target.closest('[data-modal-close]');
    if (closer) {
      e.preventDefault();
      const modal = closer.closest('.modal');
      if (modal) close(modal);
      return;
    }
    if (e.target.classList && e.target.classList.contains('modal')) {
      close(e.target);
      return;
    }

    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      e.preventDefault();
      const sel = copyBtn.getAttribute('data-copy');
      const input = document.querySelector(sel);
      if (!input) return;
      const value = input.value || input.textContent || '';
      const finish = function () {
        if (window.notyf) window.notyf.success('Copied to clipboard');
        copyBtn.classList.add('btn-success');
        setTimeout(function () { copyBtn.classList.remove('btn-success'); }, 800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(finish, function () {
          input.select(); document.execCommand('copy'); finish();
        });
      } else {
        input.select(); document.execCommand('copy'); finish();
      }
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal.show').forEach(function (m) { close(m); });
    }
  });
})();
