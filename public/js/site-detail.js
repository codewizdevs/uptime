(function () {
  if (typeof Chart === 'undefined' || typeof window.__siteId === 'undefined') return;
  const ctx = document.getElementById('rt-chart');
  if (!ctx) return;

  let chart = null;
  const buttons = document.querySelectorAll('.range-btn');

  function isDark() {
    return document.documentElement.getAttribute('data-bs-theme') === 'dark';
  }

  function chartColors() {
    return isDark()
      ? { line: '#2fb344', fill: 'rgba(47, 179, 68, 0.18)', grid: 'rgba(255,255,255,0.06)', text: '#9aa0a6' }
      : { line: '#2fb344', fill: 'rgba(47, 179, 68, 0.14)', grid: 'rgba(0,0,0,0.06)', text: '#5e6a78' };
  }

  async function load(hours) {
    const res = await fetch('/api/sites/' + window.__siteId + '/timeseries?hours=' + hours, {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) return;
    const data = await res.json();
    render(data.points);
  }

  function render(points) {
    const labels = points.map(function (p) {
      const d = new Date(p.bucket);
      return d.toLocaleString();
    });
    const values = points.map(function (p) { return p.avgMs; });
    const c = chartColors();

    if (chart) {
      chart.data.labels = labels;
      chart.data.datasets[0].data = values;
      chart.data.datasets[0].borderColor = c.line;
      chart.data.datasets[0].backgroundColor = c.fill;
      chart.options.scales.x.ticks.color = c.text;
      chart.options.scales.y.ticks.color = c.text;
      chart.options.scales.x.grid.color = c.grid;
      chart.options.scales.y.grid.color = c.grid;
      chart.update();
      return;
    }

    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'avg response time (ms)',
          data: values,
          borderColor: c.line,
          backgroundColor: c.fill,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4,
          spanGaps: true,
          borderWidth: 2,
        }],
      },
      options: {
        maintainAspectRatio: false,
        animation: { duration: 200 },
        plugins: { legend: { display: false } },
        scales: {
          x: {
            grid: { color: c.grid },
            ticks: { color: c.text, maxTicksLimit: 8, autoSkip: true },
          },
          y: {
            grid: { color: c.grid },
            ticks: { color: c.text, callback: function (v) { return v + ' ms'; } },
            beginAtZero: true,
          },
        },
      },
    });
  }

  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      buttons.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      load(parseInt(btn.getAttribute('data-hours'), 10));
    });
  });

  load(24);

  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      setTimeout(function () {
        if (chart) {
          render(chart.data.labels.map(function (l, i) { return { bucket: l, avgMs: chart.data.datasets[0].data[i] }; }));
        }
      }, 50);
    });
  }
})();
