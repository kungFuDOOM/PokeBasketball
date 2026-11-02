/* Classic script, right after framebust.js and before analytics: when Phantom sends a player back (?pj_phantom=...), take its
   parameters out of the address bar and history before Google Analytics, the Cloudflare beacon or the error reporter can read
   the URL. They are kept in memory only, for src/wallet/phantomSheet.ts. External file because the CSP blocks inline scripts. */
(function () {
  if (window.__framed || !/[?&]pj_phantom=/.test(location.search)) return;
  window.__phantomCb = location.search;
  try {
    var q = new URLSearchParams(location.search.replace(/\?/g, '&').slice(1));
    ['pj_phantom', 'pj_app', 'phantom_encryption_public_key', 'nonce', 'data', 'errorCode', 'errorMessage'].forEach(function (k) { q.delete(k); });
    var rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  } catch (e) {
    window.__phantomCb = undefined;
  }
})();
