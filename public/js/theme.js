(function () {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  function setCookie(name, value, days) {
    const d = new Date();
    d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
    document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + d.toUTCString() + '; path=/; SameSite=Lax';
  }

  btn.addEventListener('click', function () {
    const cur = document.documentElement.getAttribute('data-bs-theme') || 'light';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-bs-theme', next);
    setCookie('theme', next, 365);
    fetch('/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'theme=' + encodeURIComponent(next),
      credentials: 'same-origin',
    }).catch(function () {});
  });
})();
