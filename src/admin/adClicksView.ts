// The "Ad clicks" panel of the Ads tab (live board): clicks on paid ticker ads per link domain, from pokejam_admin_ad_clicks
// (migration 20261220). Pure HTML builder, testable without a page.
import { esc } from '../util';

export const AD_CLICKS_RPC = 'pokejam_admin_ad_clicks';

export interface AdClickRow { domain: string; ads: string[]; total: number; last_24h: number; last_7d: number }

export function adClicksHtml(rows: AdClickRow[]): string {
  const head = '<h3>Ad clicks</h3>';
  if (!rows.length) return `${head}<p class="note">No clicks on paid ads yet.</p>`;
  const sum = (k: 'total' | 'last_24h' | 'last_7d') => rows.reduce((n, r) => n + r[k], 0);
  return `${head}<div class="scroll"><table><thead><tr><th>Domain</th><th>Ads</th><th>Total</th><th>24h</th><th>7d</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><strong>${esc(r.domain)}</strong></td><td><small>${esc((r.ads ?? []).join(', '))}</small></td>
      <td class="num">${r.total}</td><td class="num">${r.last_24h}</td><td class="num">${r.last_7d}</td></tr>`).join('')}
    <tr><td><strong>All</strong></td><td></td><td class="num">${sum('total')}</td><td class="num">${sum('last_24h')}</td><td class="num">${sum('last_7d')}</td></tr>
  </tbody></table></div>`;
}

/** Shown in place of the panel when it can't load (say, the migration isn't applied yet). The ads list above still works. */
export const adClicksError = (message: string) => `<h3>Ad clicks</h3><p class="note">Couldn't load ad clicks: ${esc(message)}</p>`;
