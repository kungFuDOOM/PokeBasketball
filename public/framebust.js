/* Classic script, first in <head>: Poké Jam only boots on its own hosts and must not run inside another site's
   frame. A same-origin top window and a pokejam.xyz / www.pokejam.xyz parent are fine. Otherwise (foreign
   hostname, foreign or unknown parent) hide the page and show a link to pokejam.xyz; when framed, also try to
   break out first. window.__framed tells the boot script and the entry modules to stand down. Mirrors
   src/frameGuard.ts. External file because the CSP blocks inline scripts. */
(function () {
  if (window.__framed) return;
  // pokejam-test.vercel.app is deliberately absent (separate repo and build).
  var HOSTS = ['pokejam.xyz', 'www.pokejam.xyz', 'kungfudoom.github.io', 'localhost', '127.0.0.1', '::1', '[::1]'];
  var PARENTS = ['https://pokejam.xyz', 'https://www.pokejam.xyz'];
  function has(list, v) {
    for (var i = 0; i < list.length; i++) if (list[i] === v) return true;
    return false;
  }
  var own = null;
  try { own = location.origin; } catch (e) {}
  if (own === 'null') own = null;
  function parentOk(o) {
    return typeof o === 'string' && o !== '' && o !== 'null' && (has(PARENTS, o) || (own !== null && o === own));
  }

  var isTop = false;
  var hostOk = false;
  try {
    isTop = window.top === window.self;
    hostOk = has(HOSTS, String(location.hostname).toLowerCase().replace(/\.$/, ''));
  } catch (e) {}

  var ok = hostOk;
  if (ok && !isTop) {
    ok = false;
    try {
      ok = own !== null && window.top.location.origin === own; // reading a cross-origin top throws
    } catch (e) {}
    if (!ok) {
      var ao = null;
      try { ao = location.ancestorOrigins; } catch (e) {}
      if (ao && ao.length > 0) {
        ok = true;
        for (var i = 0; i < ao.length; i++) if (!parentOk(ao[i])) ok = false;
      } else {
        try {
          var ref = document.referrer;
          ok = typeof ref === 'string' && ref !== '' && parentOk(new URL(ref).origin);
        } catch (e) {
          ok = false;
        }
      }
    }
  }
  if (ok) return;

  window.__framed = true;
  if (!isTop) {
    try {
      window.top.location = location.href;
    } catch (e) {}
  }
  // Shown whether or not the redirect worked: some browsers block it without throwing.
  var root = document.documentElement;
  root.style.visibility = 'hidden';
  var px = "'Press Start 2P', ui-monospace, monospace";
  var box = document.createElement('div');
  box.setAttribute('id', 'framebust');
  box.style.cssText = 'visibility:visible;position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;box-sizing:border-box;' +
    'padding:16px;background:#0a0d1f;color:#f2f0e6;text-align:center;font-family:' + px;
  var msg = document.createElement('p');
  msg.textContent = 'Poké Jam only plays at pokejam.xyz';
  msg.style.cssText = 'margin:0 0 1.5em;max-width:24em;font-size:16px;font-size:min(4.5vw,6vh,26px);line-height:1.6';
  var link = document.createElement('a');
  link.setAttribute('href', 'https://pokejam.xyz/');
  link.setAttribute('target', isTop ? '_self' : '_top');
  link.setAttribute('rel', 'noopener');
  link.textContent = 'Play at pokejam.xyz';
  link.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;' +
    'min-width:min(320px,80vw);min-height:64px;padding:16px 24px;font-size:14px;font-size:min(4vw,5vh,20px);' +
    'background:#ffcb05;color:#0a0d1f;text-decoration:none;border:4px solid #f2f0e6;' +
    'box-shadow:4px 4px 0 #3b4cca;font-family:' + px;
  // Plain text so users can type the address if the sandbox blocks the link.
  var plain = document.createElement('p');
  plain.textContent = 'pokejam.xyz';
  plain.style.cssText = 'margin:1.5em 0 0;font-size:12px;font-size:min(3.5vw,4.5vh,16px);user-select:all';
  box.appendChild(msg);
  box.appendChild(link);
  box.appendChild(plain);
  root.appendChild(box);
})();
