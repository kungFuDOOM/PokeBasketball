// Ranked block of the moderation Stats panel, and the Ranked players tab. Pure HTML so the tests can render it
// without a page. Rank names come from src/ranked/rank.ts, the same list the game shows.
import { ALL_TIER_NAMES, rankName } from '../ranked/rank';
import { isNameBlocked } from '../nameFilter';
import { esc } from '../util';
import { actions, forever, when } from './reportsView';

export interface RankWindow {
  matches: number; players: number; new_profiles: number;
  forfeits: number; leaves: number; voids: number;
  shields_used: number; shield_packs: number; shield_units: number;
}
export interface RankDay { day: string; matches: number; players: number; forfeits: number; leaves: number; voids: number }
export interface RankTier { tier: string; players: number }
export interface RankTop {
  user_id: string; name: string | null; div_idx: number; points: number; rating: number; wins: number; losses: number;
}
export interface RankSeason {
  id: number; number: number; status: string; starts_at: string; ends_at: string; length_weeks: number;
  ranked: number; placing: number;
}
export interface RankPrev { number: number; ends_at: string; players: number }
export interface RankedStats {
  d1: RankWindow; d7: RankWindow; d30: RankWindow;
  days: RankDay[]; ranks: RankTier[];
  season: RankSeason | null; previous_season: RankPrev | null;
  top: RankTop[]; shields_held: number; today_starts: string; generated_at: string;
}

export interface RankedPlayer {
  user_id: string; name: string | null; wallet: string | null;
  status: string; div_idx: number; points: number; placements_played: number;
  rating: number; wins: number; losses: number; matches: number;
  last_game_at: string | null; shields: number; flags: number; banned_until: string | null;
}
export interface RankedPlayers { season_number: number | null; season_status: string | null; players: RankedPlayer[] }

const badName = (name: string | null) => (name && isNameBlocked(name) ? ' <span class="tag bad">bad name</span>' : '');
const tile = (label: string, n: number, sub = '') =>
  `<div class="stat"><b>${n}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
const pt = (iso: string) => new Date(iso).toLocaleString([], { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' });
const split = (w: RankWindow) => `${w.forfeits} forfeit · ${w.leaves} leave · ${w.voids} void`;

/** The rank the game would show. Placing players have not been given a tier yet. */
export function rankedRank(p: { status: string; div_idx: number; placements_played: number }): string {
  return p.status === 'placing' ? `Placing ${p.placements_played}/5` : rankName(p.div_idx);
}

/** A public address for the table. Twelve characters or fewer stay whole; anything longer keeps the ends. */
export function shortWallet(wallet: string | null | undefined): string {
  if (!wallet) return '—';
  const w = wallet.trim();
  if (w.length <= 12) return w;
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

export function rankedStatsHtml(s: RankedStats): string {
  const counts = new Map((s.ranks ?? []).map((r) => [r.tier, r.players]));
  const season = s.season
    ? `Season ${s.season.number} (${esc(s.season.status)}), ${s.season.length_weeks} weeks, ${esc(pt(s.season.starts_at))} – ${esc(pt(s.season.ends_at))} PT. ${s.season.ranked} ranked, ${s.season.placing} still placing.`
    : 'No season is open.';
  const prev = s.previous_season ? ` Last season (${s.previous_season.number}) archived ${s.previous_season.players} players.` : '';
  const days = s.days ?? [];
  const top = s.top ?? [];
  return `<div class="stat-grid">
    ${tile('Matches today (PT)', s.d1.matches, split(s.d1))}${tile('Matches, last 7 days', s.d7.matches, split(s.d7))}${tile('Matches, last 30 days', s.d30.matches, split(s.d30))}
    ${tile('Players today (PT)', s.d1.players)}${tile('Players, last 7 days', s.d7.players)}${tile('Players, last 30 days', s.d30.players)}
    ${tile('New profiles today (PT)', s.d1.new_profiles)}${tile('New profiles, last 7 days', s.d7.new_profiles)}${tile('New profiles, last 30 days', s.d30.new_profiles)}
    ${tile('Shields used today (PT)', s.d1.shields_used)}${tile('Shields used, last 7 days', s.d7.shields_used)}${tile('Shields used, last 30 days', s.d30.shields_used)}
    ${tile('Shield packs today (PT)', s.d1.shield_packs, `${s.d1.shield_units} shields`)}
    ${tile('Shield packs, last 7 days', s.d7.shield_packs, `${s.d7.shield_units} shields`)}
    ${tile('Shield packs, last 30 days', s.d30.shield_packs, `${s.d30.shield_units} shields`)}
    ${tile('Shields held now', s.shields_held)}
  </div>
  <p class="note">${season}${prev}</p>
  <h4>Ranks</h4>
  <div class="scroll"><table class="ranks"><thead><tr><th>Rank</th><th>Players</th></tr></thead><tbody>
    ${ALL_TIER_NAMES.map((name) => `<tr><td>${esc(name)}</td><td>${counts.get(name) ?? 0}</td></tr>`).join('')}
  </tbody></table></div>
  <h4>Matches per day</h4>
  ${days.length ? `<div class="scroll"><table class="days"><thead><tr><th>Day (PT)</th><th>Matches</th><th>Players</th><th>Forfeits</th><th>Leaves</th><th>Voids</th></tr></thead><tbody>
    ${days.map((d) => `<tr><td>${esc(d.day)}</td><td>${d.matches}</td><td>${d.players}</td><td>${d.forfeits}</td><td>${d.leaves}</td><td>${d.voids}</td></tr>`).join('')}
  </tbody></table></div>` : '<p class="note">No days.</p>'}
  <h4>Top players</h4>
  ${top.length ? `<div class="scroll"><table class="top"><thead><tr><th>Player</th><th>Rank</th><th>Rating</th><th>W-L</th></tr></thead><tbody>
    ${top.map((p) => `<tr><td>${esc(p.name ?? '?')}${badName(p.name)}</td><td>${esc(rankName(p.div_idx))}</td><td>${p.rating}</td><td>${p.wins}–${p.losses}</td></tr>`).join('')}
  </tbody></table></div>` : '<p class="note">No ranked players yet.</p>'}
  <p class="note">“Today” = Pacific time, since ${esc(pt(s.today_starts))} PT. Last 7 and 30 days are rolling. A new profile counts at its first scored match, or when the row was written if it has never been scored. Ranks and top players are the current season (placing players are not in a tier yet). Shields used come from the shield ledger (reason “use”); packs are paid purchases. Updated ${esc(pt(s.generated_at))} PT.</p>`;
}

const suspended = (iso: string | null) => iso
  ? `<span class="tag bad">suspended ${forever(iso) ? 'permanently' : `until ${esc(when(iso))}`}</span>`
  : '—';

export function rankedPlayersHtml(data: RankedPlayers): string {
  const season = data.season_number == null
    ? '<p class="note">No season is open.</p>'
    : `<p class="note">Season ${data.season_number} (${esc(data.season_status ?? '')}). Highest rating first, up to 200.</p>`;
  if (!data.players.length) return `${season}<p class="note">No ranked players this season.</p>`;
  return `${season}<div class="scroll"><table class="ranked-players"><thead><tr>
      <th>Player</th><th>Wallet</th><th>Rank</th><th>Rating</th><th>W-L</th><th>Matches</th><th>Last played</th><th>Shields</th><th>Flags</th><th>Status</th><th>Actions</th>
    </tr></thead><tbody>
    ${data.players.map((p) => {
      const full = p.wallet?.trim() ?? '';
      const wallet = full
        ? `<span title="${esc(full)}">${esc(shortWallet(full))}</span>`
        : '—';
      return `<tr>
        <td><strong>${esc(p.name ?? '?')}</strong>${badName(p.name)}<small>${esc(p.user_id.slice(0, 8))}</small></td>
        <td>${wallet}</td>
        <td>${esc(rankedRank(p))}</td>
        <td>${p.rating}</td>
        <td>${p.wins}–${p.losses}</td>
        <td>${p.matches}</td>
        <td>${p.last_game_at ? esc(when(p.last_game_at)) : '—'}</td>
        <td>${p.shields}</td>
        <td>${p.flags}</td>
        <td>${suspended(p.banned_until)}</td>
        <td class="acts">${actions({ user_id: p.user_id, name: p.name }, !!p.banned_until, 'ranked')}</td>
      </tr>`;
    }).join('')}
  </tbody></table></div>`;
}
