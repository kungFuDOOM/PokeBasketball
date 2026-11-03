// The Raffle tab of the moderation page. Pure HTML. The draw itself is the pokejam-raffle-draw Edge Function.
import { esc } from '../util';
import { shortWallet } from './rankedView';

export interface RaffleEntrant {
  user_id: string;
  name: string;
  wallet: string | null;
  whole_tokens?: string;
  offline: number;
  online: number;
  online_wins: number;
  social: number;
  rank_steps: number;
  zenith: boolean;
  grind: number;
  holder: number;
  entries: number;
}

export interface RaffleDraw {
  winner_id: string | null;
  winner_name: string | null;
  total_entries: number;
  seed: string;
  ticket: string | number | null;
  algorithm: string;
  snapshot: { entrants: RaffleEntrant[]; algorithm?: string; ticket?: string | number | null; total_entries?: number };
}

export interface RaffleAdmin {
  which: 'current' | 'previous';
  week_start: string;
  resets_at: string;
  open: boolean;
  entrants: RaffleEntrant[];
  draw: RaffleDraw | null;
}

const pt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' });
};

/** Entrants and, once drawn, the winner. Holder balances appear only on the stored snapshot. */
export function raffleHtml(s: RaffleAdmin): string {
  const drawn = s.draw;
  const rows = drawn?.snapshot.entrants?.length ? drawn.snapshot.entrants : (s.entrants ?? []);
  const which = `<p class="raffle-which"><button class="btn small${s.which === 'current' ? ' primary' : ''}" type="button" data-raffle="which" data-which="current">This week</button>
    <button class="btn small${s.which === 'previous' ? ' primary' : ''}" type="button" data-raffle="which" data-which="previous">Last week</button></p>`;
  const when = s.open ? `Still open. It ends ${esc(pt(s.resets_at))} PT. Drawing waits until then.` : `Week of ${esc(s.week_start)}, closed ${esc(pt(s.resets_at))} PT.`;
  const winner = !drawn ? '' : drawn.winner_id
    ? `<p class="note"><span class="tag ok">Winner</span> <strong>${esc(drawn.winner_name ?? 'Trainer')}</strong> <small>${esc(drawn.winner_id)}</small>. ${drawn.total_entries} entries in the hat. Nothing was paid or shipped.</p>`
    : '<p class="note">No entrants, so there is no winner. Nothing was paid or shipped.</p>';
  const proof = drawn ? `<p class="note">Check: algorithm ${esc(drawn.algorithm || 'uint64be-mod-v1')}, seed <code>${esc(drawn.seed)}</code>, ticket ${esc(String(drawn.ticket ?? ''))}. Walk the entrants below in user-id order.</p>` : '';
  const drawBtn = !s.open && !drawn
    ? `<p><button class="btn primary" type="button" data-raffle="draw" data-week="${esc(s.week_start)}">Draw a winner</button></p>`
    : '';
  const holderNote = drawn ? '' : '<p class="note">PJAM in a linked wallet is read when you draw, not on this page. The entries below do not include that bonus yet.</p>';
  const body = rows.length ? `<div class="scroll"><table class="raffle"><thead><tr>
      <th>Player</th><th>Wallet</th><th>Offline</th><th>Online</th><th>Wins</th><th>Social</th><th>Rank</th><th>Grind</th><th>Holder</th><th>Entries</th>
    </tr></thead><tbody>${rows.map((e) => `<tr class="${drawn?.winner_id === e.user_id ? 'win' : ''}">
      <td><strong>${esc(e.name || 'Trainer')}</strong><small>${esc(e.user_id)}</small></td>
      <td>${e.wallet ? `<span title="${esc(e.wallet)}">${esc(shortWallet(e.wallet))}</span>` : '—'}</td>
      <td>${e.offline}</td><td>${e.online}</td><td>${e.online_wins}</td><td>${e.social}</td>
      <td>${e.zenith ? 'Zenith' : e.rank_steps}</td><td>${e.grind}</td><td>${drawn ? e.holder : 'at draw'}</td><td>${e.entries}</td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="note">Nobody has finished every challenge this week.</p>';
  return `<div class="raffle-tab">${which}<p class="note">${when}</p>${winner}${proof}${holderNote}${drawBtn}${body}
    <p class="note">No purchase is required. The operator sends the card by hand. This page does not pay anyone or collect an address.</p></div>`;
}
