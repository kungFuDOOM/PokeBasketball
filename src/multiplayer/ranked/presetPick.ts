// Ranked team pick: both players blind-pick one of the six preset teams (presets.ts) before the match. The server
// keeps the picks hidden until both are in and auto-assigns a team to anyone who runs out the clock.
import { esc } from '../../util';
import { POSITIONS, spriteUrl } from '../../data/pokemon';
import { teamOvr } from '../shared/roster';
import { RANKED_PRESETS, presetRoster, type RankedPreset } from './presets';
import type { PickState } from './serverRank';
import { missingRpc } from '../shared/onlineMatchService';

type PresetId = RankedPreset['id'];

export interface PresetPickModel {
  /** The card tapped but not yet locked in. */
  selected: PresetId | null;
  /** The team sent to the server; set once Lock in succeeds (or the server reports an auto pick). */
  locked: PresetId | null;
  /** Seconds left to pick. */
  secondsLeft: number;
  /** A short error line (e.g. the pick did not reach the server). */
  error?: string | null;
}

export const initialPickModel = (secondsLeft = 20): PresetPickModel => ({ selected: null, locked: null, secondsLeft, error: null });

/** Tap a card. Once locked the choice is final. A mirror pick is allowed, so every card is always selectable. */
export const selectPreset = (m: PresetPickModel, id: PresetId): PresetPickModel => (m.locked ? m : { ...m, selected: id, error: null });

/** Folds a server pick state into the model: the server's pick wins (it may be an auto pick on timeout). */
export const applyPickState = (m: PresetPickModel, st: PickState): PresetPickModel =>
  ({ ...m, locked: st.mine ?? m.locked, selected: st.mine ?? m.selected, secondsLeft: Math.max(0, Math.ceil(st.deadline_s)) });

export const countdownText = (s: number): string => `0:${String(Math.max(0, Math.min(59, Math.ceil(s)))).padStart(2, '0')}`;

function cardHtml(p: RankedPreset, m: PresetPickModel): string {
  const mons = presetRoster(p.id);
  const on = (m.locked ?? m.selected) === p.id;
  return `<button type="button" class="pp-card${on ? ' on' : ''}" data-preset="${p.id}" aria-pressed="${on}"${m.locked ? ' tabindex="-1"' : ''}>
    <span class="pp-head"><b class="pp-id">${p.id}</b><span class="pp-name">${esc(p.name)}</span><span class="pp-ovr" title="Team OVR">${teamOvr(mons)}</span></span>
    <ul class="pp-mons">${mons.map((mon, i) => `<li><img src="${spriteUrl(mon.dex)}" alt="" loading="lazy"><span class="pp-pos">${POSITIONS[i]}</span><span class="pp-mon">${esc(mon.name)}</span></li>`).join('')}</ul>
  </button>`;
}

/** The pick screen. Only ever shows the player's own choice: the opponent's team is revealed by the match itself. */
export function presetPickHtml(m: PresetPickModel): string {
  const status = m.locked
    ? `<p class="pp-status" role="status">Waiting for opponent…</p>`
    : `<button type="button" class="btn primary big" data-a="lock"${m.selected ? '' : ' disabled'}>Lock in${m.selected ? ` team ${m.selected}` : ''}</button>`;
  return `<div class="menu pp"><header class="pp-top"><h1 class="pp-title">Pick your team</h1>
    <span class="pp-clock${m.secondsLeft <= 5 ? ' low' : ''}" aria-label="Seconds left">${countdownText(m.secondsLeft)}</span></header>
    <div class="pp-grid${m.locked ? ' locked' : ''}">${RANKED_PRESETS.map((p) => cardHtml(p, m)).join('')}</div>
    <footer class="pp-bar">${m.error ? `<p class="pp-err" role="alert">${esc(m.error)}</p>` : ''}${status}</footer></div>`;
}

/** The server has no preset-pick RPCs yet (an older deploy): Ranked can't start, and it never falls back to random teams. */
export class RankedUpdatingError extends Error {
  constructor() { super('Ranked is updating. Try again in a few minutes.'); this.name = 'RankedUpdatingError'; }
}

/**
 * A found Ranked match → the blind pick → the match again from pokejam_match_info, now with both preset rosters.
 * A server without the pick RPCs (PGRST202) gives RankedUpdatingError; rosters still missing after the pick is an error.
 */
export async function pickedMatch<M extends { game: { rosters?: unknown } }>(
  root: HTMLElement,
  svc: PickService & { matchInfo(id: string): Promise<M> },
  matchId: string,
  signal?: AbortSignal,
  pick: typeof runPresetPick = runPresetPick,
): Promise<M> {
  try {
    await pick(root, svc, matchId, signal);
  } catch (e) {
    if (missingRpc(e)) throw new RankedUpdatingError();
    throw e;
  }
  const m = await svc.matchInfo(matchId);
  if (!m.game.rosters) throw new Error('ranked match has no preset rosters');
  return m;
}

/** What the pick screen needs from the server (SupabaseMatchService). */
export interface PickService {
  rankedPick(matchId: string, presetId: string): Promise<void>;
  rankedPickState(matchId: string): Promise<PickState>;
}

const POLL_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shows the pick screen in `root` and resolves once both picks are in (the server auto-picks on timeout, so this
 * always ends). The caller then reads the rosters from `pokejam_match_info` and starts the game as usual.
 * `signal` aborts the wait (e.g. the player left the screen).
 */
export async function runPresetPick(root: HTMLElement, svc: PickService, matchId: string, signal?: AbortSignal): Promise<void> {
  let m = applyPickState(initialPickModel(), await svc.rankedPickState(matchId));
  const draw = () => { root.className = 'screen-menu'; root.innerHTML = presetPickHtml(m); };
  root.onclick = async (e) => {
    const t = e.target as Element;
    const card = t.closest<HTMLElement>('[data-preset]');
    if (card) { m = selectPreset(m, card.dataset.preset as PresetId); draw(); return; }
    if (t.closest('[data-a="lock"]') && m.selected && !m.locked) {
      const id = m.selected;
      m = { ...m, locked: id, error: null };
      draw();
      try { await svc.rankedPick(matchId, id); } catch { m = { ...m, locked: null, error: 'Could not lock in. Try again.' }; draw(); }
    }
  };
  draw();
  try {
    for (let last = Date.now(); !signal?.aborted;) {
      await sleep(POLL_MS);
      let st: PickState | null = null;
      try { st = await svc.rankedPickState(matchId); } catch { /* keep polling; the server timeout still ends the pick */ }
      if (st?.done) return;
      if (st) m = applyPickState(m, st);
      else m = { ...m, secondsLeft: Math.max(0, m.secondsLeft - Math.round((Date.now() - last) / 1000)) };
      last = Date.now();
      draw();
    }
    throw new Error('pick aborted');
  } finally {
    root.onclick = null;
  }
}
