'use strict';

// Bulk-set helper buttons on /settings/users/:id/grants.
// Each row has 3 radios under names like "permissions[<siteId>]" with values
// ['', 'view', 'manage']. Owner rows have no radios — they're informational.

(function () {
  function setAll(value) {
    document.querySelectorAll('input.grant-cell').forEach((el) => {
      el.checked = el.value === value;
    });
  }
  const none = document.getElementById('grants-set-none');
  const view = document.getElementById('grants-set-view');
  const manage = document.getElementById('grants-set-manage');
  if (none) none.addEventListener('click', () => setAll(''));
  if (view) view.addEventListener('click', () => setAll('view'));
  if (manage) manage.addEventListener('click', () => setAll('manage'));
})();
