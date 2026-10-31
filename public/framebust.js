/* Classic script, first in <head>: Poké Jam must not run inside another site's frame. A same-origin top window is
   fine. Otherwise try to break out; if that is blocked (sandbox without allow-top-navigation, or the browser's
   no-user-gesture rule), hide the page and show a link to pokejam.xyz. window.__framed tells the boot script and
   the entry modules to stand down. External file because the CSP blocks inline scripts. */
(function () {
  var framed;
  try {
    framed = window.top !== window.self && window.top.location.origin !== location.origin;
  } catch (e) {
    framed = true; // reading a cross-origin top throws
  }
  if (!framed || window.__framed) return;
  window.__framed = true;
  try {
    window.top.location = location.href;
  } catch (e) {}
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
  link.setAttribute('href', 'https://pokejam.xyz');
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener');
  link.textContent = 'Play at pokejam.xyz';
  link.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;' +
    'min-width:min(320px,80vw);min-height:64px;padding:16px 24px;font-size:14px;font-size:min(4vw,5vh,20px);' +
    'background:#ffcb05;color:#0a0d1f;text-decoration:none;border:4px solid #f2f0e6;' +
    'box-shadow:4px 4px 0 #3b4cca;font-family:' + px;
  box.appendChild(msg);
  box.appendChild(link);
  root.appendChild(box);
})();
