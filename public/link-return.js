/* Classic script, before analytics: linking a Phantom wallet comes back with ?pj_wlink=..., which is not a sign-in.
   Take it out of the address bar before analytics. The sign-in page only looks for pj_phantom, so this cannot start one. */
(function () {
  if (window.__framed || !/[?&]pj_wlink=/.test(location.search)) return;
  window.__linkCb = location.search;
  try {
    var q = new URLSearchParams(location.search.replace(/\?/g, '&').slice(1));
    ['pj_wlink', 'pj_wapp', 'pj_wh', 'pj_wk', 'pj_ws', 'pj_uid', 'phantom_encryption_public_key', 'nonce', 'data', 'errorCode', 'errorMessage'].forEach(function (k) { q.delete(k); });
    var rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  } catch (e) {
    window.__linkCb = undefined;
  }
})();
