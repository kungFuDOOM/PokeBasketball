// The Ads tab of the moderation page, as pure HTML builders (testable without a page). Two boards share the tab:
//   devnet  the test site's board (its devnet Edge Function, migration 20261104): pokejam_admin_ads / pokejam_admin_ad_remove
//   live    pokejam.xyz's mainnet board (pokejam-ads-live, migration 20261124): pokejam_admin_live_ads /
//           pokejam_admin_live_ad_remove
// The ban list is shared by both boards (20261124 reads pokejam_ad_bans), so Lift is pokejam_admin_ad_unban on either.
import { esc } from '../util';
import { when } from './reportsView';

export type AdBoard = 'devnet' | 'live';
export const AD_BOARDS: readonly AdBoard[] = ['devnet', 'live'];
export const AD_BOARD_LABEL: Record<AdBoard, string> = { devnet: 'Devnet (test site)', live: 'Live (mainnet)' };

/** Which moderator RPCs each board uses. */
export const AD_RPC: Record<AdBoard, { list: string; remove: string; bans: string; unban: string }> = {
  devnet: { list: 'pokejam_admin_ads', remove: 'pokejam_admin_ad_remove', bans: 'pokejam_admin_ad_bans', unban: 'pokejam_admin_ad_unban' },
  live: { list: 'pokejam_admin_live_ads', remove: 'pokejam_admin_live_ad_remove', bans: 'pokejam_admin_ad_bans', unban: 'pokejam_admin_ad_unban' },
};

export const isAdBoard = (x: unknown): x is AdBoard => x === 'devnet' || x === 'live';

export interface AdRow {
  id: string; text: string; theme: string; wallet: string; state: 'paid' | 'removed'; starts_at: string; ends_at: string; burn_sig: string | null;
  removed_reason: string | null; banned: boolean; reports: number; reasons: Record<string, number> | null;
  /** Live board only: how it was paid. */
  pay_method?: 'burn' | 'usdc'; usdc_sig?: string | null;
}
export interface AdBan { wallet: string; reason: string | null; at: string }

/** The Devnet / Live switch at the top of the Ads tab. */
export function boardSwitch(board: AdBoard): string {
  return `<div class="tabs ad-boards" role="group" aria-label="Which ads board">${AD_BOARDS.map((b) =>
    `<button class="${b === board ? 'on' : ''}" data-board="${b}" aria-pressed="${b === board}">${esc(AD_BOARD_LABEL[b])}</button>`).join('')}</div>`;
}

const paidWith = (a: AdRow) => (a.pay_method === 'usdc' ? 'USDC' : a.pay_method === 'burn' ? '$PJAM burn' : '');

export function adsHtml(rows: AdRow[], bans: AdBan[], board: AdBoard = 'devnet', now = Date.now()): string {
  const status = (a: AdRow) => a.state === 'removed' ? `<span class="tag bad">taken down${a.banned ? ', banned' : ''}</span><small>${esc(a.removed_reason ?? '')}</small>`
    : Date.parse(a.ends_at) <= now ? '<span class="tag">ended</span>' : Date.parse(a.starts_at) > now ? '<span class="tag">scheduled</span>' : '<span class="tag">live</span>';
  const d = (a: AdRow) => `data-id="${esc(a.id)}" data-text="${esc(a.text)}" data-board="${board}"`;
  const head = board === 'live' ? '<p class="note">Live board (pokejam.xyz, Solana mainnet). Bans apply to both boards.</p>' : '';
  const table = rows.length ? `<div class="scroll"><table><thead><tr><th>Ad</th><th>Wallet</th><th>Runs</th><th>Reports</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((a) => `<tr>
      <td><strong>${esc(a.text)}</strong><small>${esc(a.theme)}${board === 'live' && paidWith(a) ? ` · ${esc(paidWith(a))}` : ''}</small></td>
      <td><small>${esc(a.wallet)}</small></td>
      <td>${esc(when(a.starts_at))}<small>to ${esc(when(a.ends_at))}</small></td>
      <td class="num">${a.reports}<small>${Object.entries(a.reasons ?? {}).map(([k, n]) => `${esc(k)} ${n}`).join(', ')}</small></td>
      <td>${status(a)}</td>
      <td class="acts">${a.state === 'paid' && Date.parse(a.ends_at) > now ? `<button class="btn small" data-ad="remove" ${d(a)}>Take down</button>
        <button class="btn small danger" data-ad="ban" ${d(a)}>Take down + ban</button>` : ''}</td></tr>`).join('')}
  </tbody></table></div>` : '<p class="note">No ads in this period.</p>';
  const banned = bans.length ? `<h3>Banned from advertising (both boards)</h3><div class="scroll"><table><thead><tr><th>Wallet</th><th>Why</th><th>Since</th><th></th></tr></thead><tbody>
    ${bans.map((b) => `<tr><td><small>${esc(b.wallet)}</small></td><td>${esc(b.reason ?? '')}</td><td>${esc(when(b.at))}</td>
      <td class="acts"><button class="btn small" data-ad="unban" data-wallet="${esc(b.wallet)}" data-board="${board}">Lift</button></td></tr>`).join('')}
  </tbody></table></div>` : '';
  return boardSwitch(board) + head + table + banned;
}

/** The confirm dialog's words for an ad action. */
export function adConfirm(act: string, text: string, wallet: string, board: AdBoard): string {
  if (act === 'unban') return `Let ${wallet} advertise again (on both boards)?`;
  const where = board === 'live' ? ' on the LIVE board' : '';
  return act === 'ban'
    ? `Take down "${text}"${where} and every other ad from this wallet, and ban it from advertising? ${board === 'live' ? 'Payments (burns or USDC)' : 'The burns'} can't be given back.`
    : `Take down "${text}"${where}? The advertiser keeps the time it had left and can run it with new text.`;
}

/** The RPC and arguments for an ad action button, or null for an unknown one. */
export function adAction(act: string, board: AdBoard, d: { id?: string; wallet?: string }, reason: string): { fn: string; args: Record<string, unknown> } | null {
  const rpc = AD_RPC[board];
  if (act === 'unban') return d.wallet ? { fn: rpc.unban, args: { p_wallet: d.wallet } } : null;
  if (act === 'remove' || act === 'ban') return d.id ? { fn: rpc.remove, args: { p_id: d.id, p_reason: reason, p_ban: act === 'ban' } } : null;
  return null;
}
