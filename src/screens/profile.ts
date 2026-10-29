// Player profile: username, rank badge, records, placements, peak rank, Social and offline stats. `profileHtml` is pure
// (unit-tested); `openProfile` loads what exists and wires the buttons. The ranked parts only show when Ranked is on in
// this build (MODE_RANKED), so the live menu doesn't advertise it; the offline stats always show.
import { MODE_RANKED } from '../config/features';
import { ONLINE_CONFIGURED } from '../multiplayer/shared/supabase';
import { rankName, ZENITH_IDX } from '../ranked/rank';
import { displayName } from '../multiplayer/ranked/username';
import { rankChipHtml, signInPanelHtml } from '../multiplayer/ranked/view';
import type { RankedMe } from '../multiplayer/ranked/serverRank';
import { phantomAction, type PhantomAction } from '../wallet/phantom';
import { esc } from '../util';

// The same markup as matchFlow's panel(), kept here so the pure profileHtml tests don't pull in the game code.
const panel = (title: string, tag: string, inner: string) => `<div class="menu"><header class="title"><h1 class="logo"><span class="logo-jam">${esc(title)}</span></h1>
    <p class="tag">${esc(tag)}</p></header><section class="card setup">${inner}</section></div>`;

export interface LocalSummary { franchise: string | null; drafted: string | null }

export interface ProfileModel {
  /** Ranked is on in this build: shows the username, rank and sign-in. */
  rankedOn: boolean;
  /** Online is set up in this build (a guest can be offered sign-in). */
  onlineAvailable: boolean;
  /** A real (non-guest) account is signed in. */
  signedIn: boolean;
  username: string | null;
  /** When a username change is allowed again (null = now). */
  nextChangeAt: string | null;
  me: RankedMe | null;
  social: { played: number; won: number } | null;
  local: LocalSummary;
}

/** "57%" or an en dash with no games. */
export const winRate = (w: number, l: number) => (w + l === 0 ? '–' : `${Math.round((100 * w) / (w + l))}%`);

const peakText = (idx: number) => (idx >= ZENITH_IDX ? 'Zenith' : rankName(idx));
const row = (k: string, v: string) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;

function rankedRows(me: RankedMe | null): string {
  if (!me) return row('Ranked', 'Not available right now');
  if (me.placing) {
    return row('Placements', `${me.placementsPlayed} / 5 played`) + row('Ranked record', 'After placements');
  }
  return row('Ranked record', `${me.wins}W – ${me.losses}L`) + row('Win rate', winRate(me.wins, me.losses))
    + row('Placements', 'Complete') + row('Peak rank', me.peakIdx != null ? esc(peakText(me.peakIdx)) : '–');
}

/** The profile screen's body (inside a panel). Every name and string from outside is escaped. */
export function profileHtml(m: ProfileModel, phantom: PhantomAction, o: { error?: string | null; busy?: boolean } = {}): string {
  const guest = !m.signedIn;
  const showRanked = m.rankedOn && m.signedIn;
  const name = guest ? 'Guest' : displayName(m.username);
  const wait = m.nextChangeAt ? ` title="You can change your name again on ${esc(new Date(m.nextChangeAt).toLocaleDateString())}"` : '';
  const id = `<div class="pf-id"><span class="pf-label">${guest ? 'Playing as' : 'Username'}</span><strong class="pf-name" data-pf="name">${esc(name)}</strong>
    ${showRanked ? `<button class="btn ghost pf-edit" type="button" data-a="rename"${wait}>${m.username ? 'Change name' : 'Pick a username'}</button>` : ''}</div>`;
  const left = [id];
  if (showRanked && m.username) left.push(rankChipHtml(m.me));
  if (m.rankedOn && guest && m.onlineAvailable) {
    left.push(`<div class="pf-signin" data-signin>${signInPanelHtml(phantom, { ...o, why: 'Sign in to get a username and a rank that follow you. Guests can still play and keep the stats below.' })}</div>`);
  }
  const rows: string[] = [];
  if (showRanked && m.username) rows.push(rankedRows(m.me));
  if (m.social) rows.push(row('Social', `${m.social.won}W – ${m.social.played - m.social.won}L (unranked)`));
  if (m.local.franchise) rows.push(row('Franchise', esc(m.local.franchise)));
  if (m.local.drafted) rows.push(row('Season Draft', esc(m.local.drafted)));
  if (!rows.length) rows.push(row('Stats', 'Play a game and your record shows up here.'));
  return `<div class="pf" data-pf="profile"><div class="pf-left">${left.join('')}</div>
    <div class="pf-right"><dl class="pf-stats">${rows.join('')}</dl>
    <div class="actions center"><button class="btn ghost" data-a="back">Back</button></div></div></div>`;
}

/** Opens the profile. `local` is what this device knows (franchise and Season Draft records). */
export async function openProfile(ctx: { root: HTMLElement; back(): void }, local: LocalSummary): Promise<void> {
  const { root } = ctx;
  root.className = 'screen-menu';
  window.scrollTo(0, 0);
  const base: ProfileModel = { rankedOn: MODE_RANKED, onlineAvailable: false, signedIn: false, username: null, nextChangeAt: null, me: null, social: null, local };
  const draw = (m: ProfileModel, extra?: { error?: string | null; busy?: boolean }) => {
    root.innerHTML = panel('PROFILE', m.signedIn ? 'Your record' : 'Your record on this device', profileHtml(m, phantomAction(), extra));
    root.querySelector('[data-a="back"]')?.addEventListener('click', ctx.back);
  };
  draw(base);
  if (!ONLINE_CONFIGURED) return;
  try {
    const { loadProfileModel, wireProfile } = await import('../multiplayer/ranked/profileData');
    const model = await loadProfileModel(base);
    if (!root.isConnected) return;
    const redraw = (extra?: { error?: string | null; busy?: boolean }) => { draw(model, extra); wireProfile(root, model, ctx, redraw, () => void openProfile(ctx, local)); };
    redraw();
  } catch { /* offline stats are already on screen */ }
}
