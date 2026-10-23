/* Classic script that runs before the game bundle. If the bundle can't start (old browser, blocked script, a
   throw while loading), the page would stay blank: show a readable message instead. The bundle sets
   window.__bootOk as its very first act; once that is set this script stays out of the way. */
(function () {
  function show(detail) {
    var app = document.getElementById('app');
    if (window.__bootOk || !app || app.children.length) return;
    app.innerHTML = '<div style="max-width:30em;margin:18vh auto 0;padding:0 20px;font:16px/1.5 system-ui,sans-serif;color:#f2f0e6;text-align:center">' +
      '<h1 style="font-size:1.4em;margin:0 0 .5em">Poké Jam couldn’t load</h1>' +
      '<p>Your browser may be too old, or the page didn’t finish downloading. Reload the page, or update your browser (iPadOS/iOS 14 or later, Chrome 80 or later).</p>' +
      (detail ? '<p style="opacity:.6;font-size:.8em;word-break:break-word"></p>' : '') + '</div>';
    var p = app.querySelector('p:last-child');
    if (detail && p) p.textContent = detail;
  }
  window.__bootFail = show;
  window.addEventListener('error', function (e) {
    if (e && e.target && e.target !== window) return; // resource errors (sprites) are handled elsewhere
    show(e && e.message ? String(e.message).slice(0, 160) : '');
  });
  window.addEventListener('unhandledrejection', function (e) {
    show(e && e.reason && e.reason.message ? String(e.reason.message).slice(0, 160) : '');
  });
  // Slow connections are fine: only give up when the page has fully loaded (or 30s passed) and the bundle never started.
  var waited = 0;
  (function check() {
    if (window.__bootOk) return;
    waited += 2000;
    if (waited >= 20000 && (document.readyState === 'complete' || waited >= 30000)) show('The game did not start.');
    else window.setTimeout(check, 2000);
  })();
})();
