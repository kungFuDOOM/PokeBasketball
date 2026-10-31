/* Google Analytics 4 (anonymous traffic stats), classic script loaded after framebust.js. External file because
   the CSP blocks inline scripts. Inside another site's frame it does nothing at all: no dataLayer, no gtag.js.
   Google signals and ad personalization are off. */
(function () {
  if (window.top !== window.self) return;
  var ID = 'G-HHF6EXVVZB';
  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', ID, { allow_google_signals: false, allow_ad_personalization_signals: false });
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
  document.head.appendChild(s);
})();
