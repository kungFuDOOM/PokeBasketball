/** Pre-game intro: both lineups side by side for a few seconds before tip-off. DOM only, existing sprites. */
import { spriteUrl, type Mon } from '../data/pokemon';
import { teamOvr } from '../game/game';
import type { TeamDef } from '../game/types';
import { esc } from '../util';
import { introEnabled, introLength, type IntroCtx, type IntroMode, type IntroVotes } from './intro.logic';

export interface IntroOptions {
  home: TeamDef;
  away: TeamDef;
  /** Optional rank chip text, e.g. "Gold II". */
  homeLabel?: string;
  awayLabel?: string;
  /** Online: Skip is a vote, the intro ends early only when both players skip. */
  online?: { votes: IntroVotes; onVote(skip: boolean): void };
  lengthMs: number;
  capMs?: number;
  /** Offline: Skip ends the intro at once. */
  instantSkip: boolean;
  mySide?: 0 | 1;
}

export interface IntroHandle {
  done: Promise<void>;
  finishNow(): void;
  /** The opponent's skip vote changed (online). */
  peerState(skip: boolean): void;
  destroy(): void;
}

function teamHtml(t: TeamDef, label: string | undefined, mine: boolean): string {
  const row = (m: Mon) =>
    `<li><img src="${spriteUrl(m.dex)}" alt=""><b>${esc(m.pos)}</b><span>${esc(m.name)}</span><i>${m.ovr}</i></li>`;
  return `<div class="intro-team${mine ? ' mine' : ''}" style="--team:${esc(t.color)}">
      <h2>${esc(t.name)}</h2>
      <div class="intro-meta"><span class="intro-ovr">${teamOvr(t.roster)} OVR</span>${label ? `<span class="intro-rank">${esc(label)}</span>` : ''}</div>
      <ul>${t.roster.slice(0, 5).map(row).join('')}</ul>
    </div>`;
}

/** Pure markup builder (tested without a DOM). */
export function introHtml(o: Pick<IntroOptions, 'home' | 'away' | 'homeLabel' | 'awayLabel' | 'online' | 'mySide'>): string {
  const skipLabel = o.online ? o.online.votes.label() : 'Skip';
  return `<div class="intro">
    <div class="intro-teams">
      ${teamHtml(o.home, o.homeLabel, o.mySide === 0)}
      <div class="intro-vs">VS</div>
      ${teamHtml(o.away, o.awayLabel, o.mySide === 1)}
    </div>
    <button class="btn intro-skip" type="button" aria-pressed="false">${esc(skipLabel)}</button>
  </div>`;
}

export function showIntro(root: HTMLElement, o: IntroOptions): IntroHandle {
  root.className = 'screen-intro';
  root.innerHTML = introHtml(o);
  const btn = root.querySelector<HTMLButtonElement>('.intro-skip')!;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let finished = false;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));

  const clear = () => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clear();
    resolve();
  };
  const refresh = () => {
    if (!o.online) return;
    btn.textContent = o.online.votes.label();
    btn.setAttribute('aria-pressed', String(o.online.votes.mine));
    btn.classList.toggle('on', o.online.votes.mine);
  };

  // The cap bounds the intro even if a caller passes a longer length.
  timers.push(setTimeout(finish, Math.min(o.lengthMs, o.capMs ?? Infinity)));

  btn.addEventListener('click', () => {
    if (finished) return;
    if (o.online) {
      const skip = !o.online.votes.mine;
      o.online.votes.vote('mine', skip);
      o.online.onVote(skip);
      refresh();
      if (o.online.votes.both()) finish();
    } else if (o.instantSkip) {
      finish();
    }
  });

  return {
    done,
    finishNow: finish,
    peerState(skip: boolean) {
      if (finished || !o.online) return;
      o.online.votes.vote('theirs', skip);
      refresh();
      if (o.online.votes.both()) finish();
    },
    destroy() {
      finished = true;
      clear();
    },
  };
}

/**
 * Offline games: show the intro (if the setting allows it), then start the game. Renders before playGame, which
 * replaces root's contents, so it never overlays a running game. Returns the intro handle (null when skipped) so a
 * caller leaving early can destroy() it; if root was replaced meanwhile, `then` is not called.
 */
export function withIntro(
  root: HTMLElement,
  cfg: { home: TeamDef; away: TeamDef },
  ctx: IntroCtx,
  settings: { introMode?: IntroMode },
  then: () => void,
): IntroHandle | null {
  const mode = settings.introMode ?? 'full';
  if (!introEnabled(mode, ctx)) {
    then();
    return null;
  }
  const h = showIntro(root, { home: cfg.home, away: cfg.away, mySide: 0, ...introLength(ctx, false, mode) });
  const intro = root.querySelector('.intro');
  let live = true;
  void h.done.then(() => {
    if (!live || root.querySelector('.intro') !== intro) return;
    live = false;
    root.className = 'screen-game';
    then();
  });
  return {
    ...h,
    destroy() {
      live = false;
      h.destroy();
    },
  };
}
