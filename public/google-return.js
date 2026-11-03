/* Classic script, before analytics: a home-screen Google sign-in comes back in Safari with ?pj_google=... and an OAuth
   code. Take both out of the address bar before Google Analytics or the Cloudflare beacon can read them. The module
   exchanges the code itself. A normal same-tab Google sign-in has no pj_google and is left for the main client. */
(function () {
  if (window.__framed || !/[?&]pj_google=/.test(location.search)) return;
  window.__googleCb = location.search;
  try {
    var q = new URLSearchParams(location.search.replace(/\?/g, '&').slice(1));
    ['pj_google', 'pj_gk', 'pj_to', 'code', 'error', 'error_code', 'error_description'].forEach(function (k) { q.delete(k); });
    var rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  } catch (e) { /* the stashed query is still there for the module */ }
})();
