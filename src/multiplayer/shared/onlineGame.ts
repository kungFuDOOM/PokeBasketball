// Plays one online match: connect → lockstep game → both players report the result.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Game } from '../../game/game';
import { playGame, type PlayHandle } from '../../screens/play';
import { resultsScreen } from '../../screens/results';
import { esc } from '../../util';
import { classify } from './capacity';
import { Lockstep } from './lockstep';
import { panel } from './matchFlow';
import type { ReportOutcome } from './matchService';
import { pack } from './evidence';
import { connect, iceFor, type Connected, type MatchLink } from './netplay';
import type { OnlineMatch, OnlineOpponent, ReportReason, SupabaseMatchService } from './onlineMatchService';
import type { ModeContext } from './types';

/** No word from the other player for this long ends the game. */
const PEER_TIMEOUT_MS = 15_000;

/** Dev builds only: ?ql=10 plays 10-second quarters (used by the two-browser end-to-end test). Otherwise the server's. */
function quarterLenOverride(): number | undefined {
  if (import.meta.env.DEV) {
    const ql = Number(new URLSearchParams(location.search).get('ql'));
    if (ql >= 5 && ql <= 300) return ql;
  }
  return undefined;
}

export interface OnlineGameOptions {
  sb: SupabaseClient;
  service: SupabaseMatchService;
  match: OnlineMatch;
  /** Shown on the results screen. */
  outcomeHtml: string | ((out: ReportOutcome) => string);
  playAgain(): void;
}

export async function playOnline(ctx: ModeContext, o: OnlineGameOptions) {
  const { root, audio } = ctx;
  const { match, service } = o;
  const abort = new AbortController();
  root.className = 'screen-menu';
  root.innerHTML = panel('CONNECTING', `Connecting to ${match.opponent.name}…`, `
    <div class="actions center"><button class="btn ghost" data-a="cancel">Cancel</button></div>`);
  root.querySelector('[data-a="cancel"]')!.addEventListener('click', () => abort.abort());

  let link: MatchLink;
  let cfg;
  let conn: Connected;
  try {
    conn = await connect(o.sb, match, quarterLenOverride(), abort.signal, service);
    ({ cfg, link } = conn);
  } catch (e) {
    await service.leave(match.id);
    if ((e as Error).name === 'AbortError') return ctx.back();
    const p = classify(e);
    return message(ctx, p.kind === 'busy' ? 'ONLINE IS BUSY' : 'NO CONNECTION', p.message);
  }

  // Move gameplay to a relayed direct link if the server hands out TURN credentials (stays on Realtime otherwise).
  void iceFor(o.sb, match.id).then((ice) => { if (ice && !over) link.upgrade(match.side, ice.iceServers, ice.policy); });

  // After the game, each player uploads everything signed they hold, for the winner check (once; best effort).
  let uploaded = false;
  const uploadEvidence = () => {
    if (uploaded || !link.evidence || !conn.keys) return;
    uploaded = true;
    void pack(link.evidence.evidence(conn.setup, conn.keys)).then((p) => service.submitEvidence(match.id, p)).catch(() => {});
  };

  let ls: Lockstep | null = null;
  let handle: PlayHandle | null = null;
  let over = false;
  const end = async (title: string, note: string) => {
    if (over) return;
    over = true;
    clearInterval(watch);
    handle?.stop();
    ls?.bye();
    uploadEvidence();
    link.close();
    await service.leave(match.id);
    message(ctx, title, note, { service, match });
  };
  const watch = setInterval(() => {
    if (!ls || over) return;
    if (ls.problem) void end('GAME STOPPED', `${ls.problem} No result was recorded.`);
    else if (ls.peerLeft) void end('OPPONENT LEFT', `${match.opponent.name} left the game. No result was recorded.`);
    else if (performance.now() - ls.lastHeard > PEER_TIMEOUT_MS) void end('CONNECTION LOST', `Lost the connection to ${match.opponent.name}. No result was recorded.`);
  }, 1000);

  audio.unlock();
  root.className = 'screen-game';
  handle = playGame(root, cfg, audio, (g) => void finish(g), () => void end('LEFT GAME', 'You left the game. No result was recorded.'), {
    online: {
      viewTeam: match.side,
      start: (g) => { ls = new Lockstep(g, link, { side: match.side }); link.attach(ls); },
      advance: (intent, dt) => ls!.advance(intent, dt),
      status: () => (ls && ls.waiting > 0.4 ? `Waiting for ${match.opponent.name}…` : null),
    },
  });

  async function finish(g: Game) {
    if (over) return;
    over = true;
    clearInterval(watch);
    const mine = g.score[match.side];
    const theirs = g.score[1 - match.side];
    const won = mine > theirs;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__pokejamOnline = { hash: ls?.hash(), score: [...g.score], side: match.side, stats: ls?.stats, delay: ls?.delay, matchId: match.id, sent: link.sent, direct: link.direct };
    // Let the last lockstep messages reach the other player before leaving the channel.
    setTimeout(() => { uploadEvidence(); link.close(); }, 3000);
    const show = (out: ReportOutcome) => (typeof o.outcomeHtml === 'function' ? o.outcomeHtml(out) : o.outcomeHtml);
    let note: string;
    let later: Promise<ReportOutcome> | undefined;
    try {
      const opp: OnlineOpponent = { ...match.opponent, matchId: match.id, mySide: match.side };
      const out = await service.reportResult(match.queue, opp, { won, score: [mine, theirs], engineVersion: g.engineVersion, seed: g.seed });
      note = show(out);
      later = out.later;
    } catch {
      note = `${typeof o.outcomeHtml === 'string' ? o.outcomeHtml : ''}<p class="note center">Could not record the result.</p>`;
    }
    root.className = 'screen-results';
    window.scrollTo(0, 0);
    resultsScreen(root, g, {
      tag: match.queue === 'ranked' ? 'Ranked match' : 'Social match',
      headline: won ? 'You win!' : `${g.teams[1 - match.side].name} win`,
      extraHtml: `<div data-outcome>${note}</div>`,
      buttons: [{ id: 'again', label: 'Play again', kind: 'primary' }, { id: 'hub', label: 'Back', kind: 'ghost' }, { id: 'report', label: 'Report or block', kind: 'ghost' }],
      onAction: (a) => (a === 'again' ? o.playAgain() : a === 'report' ? reportScreen(ctx, service, match, ctx.back) : ctx.back()),
    });
    // Ranked, other player not reported yet: fill in the rating change when the server has rated the match.
    void later?.then((out) => {
      const slot = root.querySelector('[data-outcome]');
      if (slot) slot.innerHTML = show(out);
    });
  }
}

/** A dead end with a Back button, plus Report or block when there was an opponent. */
export function message(ctx: ModeContext, title: string, note: string, who?: { service: SupabaseMatchService; match: OnlineMatch }) {
  ctx.root.className = 'screen-menu';
  window.scrollTo(0, 0);
  ctx.root.innerHTML = panel(title, note, `<div class="actions center"><button class="btn primary" data-a="back">Back</button>
    ${who ? '<button class="btn ghost" data-a="report">Report or block</button>' : ''}</div>`);
  ctx.root.querySelector('[data-a="back"]')!.addEventListener('click', ctx.back);
  ctx.root.querySelector('[data-a="report"]')?.addEventListener('click', () => reportScreen(ctx, who!.service, who!.match, () => message(ctx, title, note, who)));
}

const REASONS: [ReportReason, string][] = [['name', 'Offensive name'], ['cheating', 'Cheating'], ['quitting', 'Quitting or stalling'], ['other', 'Something else']];

/** Report the opponent (one report per match; a person reviews them) and/or block them. */
function reportScreen(ctx: ModeContext, service: SupabaseMatchService, match: OnlineMatch, back: () => void) {
  const { root } = ctx;
  const name = match.opponent.name;
  root.className = 'screen-menu';
  window.scrollTo(0, 0);
  root.innerHTML = panel('REPORT OR BLOCK', `What happened with ${name}?`, `
    <div class="actions center">${REASONS.map(([r, label]) => `<button class="btn" data-r="${r}">${esc(label)}</button>`).join('')}</div>
    <div class="actions center"><button class="btn" data-a="block">Block ${esc(name)}</button></div>
    <p class="note center" data-a="msg" hidden></p>
    <div class="actions center"><button class="btn ghost" data-a="back">Back</button></div>`);
  const msg = root.querySelector<HTMLElement>('[data-a="msg"]')!;
  const say = (t: string) => { msg.hidden = false; msg.textContent = t; };
  root.querySelector('[data-a="back"]')!.addEventListener('click', back);
  root.querySelectorAll<HTMLButtonElement>('[data-r]').forEach((b) => b.addEventListener('click', async () => {
    root.querySelectorAll<HTMLButtonElement>('[data-r]').forEach((x) => (x.disabled = true));
    try {
      say((await service.report(match.id, b.dataset.r as ReportReason)) ? `Thanks. ${name} was reported and a person will look at it.` : 'You already reported this match.');
    } catch (e) {
      root.querySelectorAll<HTMLButtonElement>('[data-r]').forEach((x) => (x.disabled = false));
      say(classify(e).message);
    }
  }));
  root.querySelector<HTMLButtonElement>('[data-a="block"]')!.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      await service.block(match.id);
      say(`${name} is blocked. You won't be matched with them again.`);
    } catch (x) {
      btn.disabled = false;
      say(classify(x).message);
    }
  });
}
