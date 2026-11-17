// Click logging for paid ticker ads: one fire-and-forget POST to the ads function (action 'click'). The link itself is a
// plain <a target="_blank">, so it opens instantly; this only reports it. It never throws and never waits.
// Only real booked ads have a server id: the $PJAM house link and "YOUR AD HERE" have none and are never logged.
import { ADS_ENDPOINT } from './api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reports a click on a paid ad. Returns whether a report was sent (false for non-paid links, no endpoint, or a failure). */
export function logAdClick(adId: string | null | undefined, href: string | null | undefined, endpoint: string = ADS_ENDPOINT): boolean {
  try {
    if (!endpoint || !adId || !UUID.test(adId) || !href) return false;
    if (new URL(href).protocol !== 'https:') return false;
    // text/plain keeps this a CORS "simple" request (no preflight); keepalive lets it finish after the tab loses focus.
    const p = fetch(endpoint, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ action: 'click', id: adId, url: href }), keepalive: true, credentials: 'omit' });
    void Promise.resolve(p).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
