/* Classic script, before analytics: a home-screen Discord sign-in comes back in Safari with ?pj_discord=... and an OAuth
   code. Take both out of the address bar before Discord Analytics or the Cloudflare beacon can read them. The module
   exchanges the code itself. A normal same-tab Discord sign-in has no pj_discord and is left for the main client. */
(function () {
  if (window.__framed || !/[?&]pj_discord=/.test(location.search)) return;
  window.__discordCb = location.search;
  try {
    var q = new URLSearchParams(location.search.replace(/\?/g, '&').slice(1));
    ['pj_discord', 'pj_gk', 'pj_to', 'code', 'error', 'error_code', 'error_description'].forEach(function (k) { q.delete(k); });
    var rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  } catch (e) { /* the stashed query is still there for the module */ }
})();
