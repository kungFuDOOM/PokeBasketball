// Plays one online match: connect → lockstep game → both players report the result.
import type { SupabaseClient } from '@supabase/supabase-js';
import { JUDGE_AUTHORITATIVE } from '../../config/features';
import type { Game } from '../../game/game';
import { playGame, type PlayHandle } from '../../screens/play';
import { resultsScreen } from '../../screens/results';
import { esc } from '../../util';
import { classify } from './capacity';
import { Lockstep, resyncLimitFor } from './lockstep';
import { panel } from './matchFlow';
import type { ReportOutcome } from './matchService';
import { pack } from './evidence';
import { evidenceQueue, uploadOnExit } from './evidenceQueue';
import { quitNoticeText } from '../ranked/view';
import { showIntro } from '../../screens/intro';
import { INTRO_CAP_MS, INTRO_LEN_MS, IntroVotes, startingFiveEnabled } from '../../screens/intro.logic';
import { PreGate } from './pre';
import { MatchOverError, connect, iceFor, type Connected, type MatchLink } from './netplay';
import { netStatsRow, submitNetStats } from './netStats';
import type { OnlineMatch, OnlineOpponent, ReportReason, SupabaseMatchService } from './onlineMatchService';
import { onPageExit } from './pageExit';
import { keepaliveRpc } from './supabase';
import type { ModeContext } from './types';

/** No word from the other player for this long ends the game. */
const PEER_TIMEOUT_MS = 15_000;
/** How long to wait for the direct link to open before measuring the connection (it stays on Realtime if it doesn't). */
const DIRECT_WAIT_MS = 6000;
/** How often a player in the game tells the server they're still there (service.alive). */
const HEARTBEAT_MS = 30_000;
const CHECKING = 'Checking the result… This can take a few minutes.';
const STILL_CHECKING = 'The server is still checking this match. Your rank updates when it is done.';

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
  // Closing the tab while connecting or playing: say bye and leave the match at once (the other player otherwise
  // waits out the connection timeout). Off once the game has finished, so a result being settled isn't voided.
  // The leave goes first: a send on a closing data channel can throw, and the leave is what calls the match off.
  let sayBye = () => {};
  const offExit = onPageExit(() => {
    service.leaveOnExit(match.id);
    try { sayBye(); } catch { /* the channel is already going */ }
  });

  let link: MatchLink;
  let cfg: Connected['cfg'];
  let conn: Connected;
  // The leave has already been sent. A quit that counted shows the warning or the ban; a void goes back quietly.
  const rankedQuitMessage = (note: string, who?: { service: SupabaseMatchService; match: OnlineMatch }) => {
    message(ctx, 'LEFT RANKED', note, who);
    ctx.root.querySelector('.menu')?.classList.add('rk-note');
  };
  const quitOrBack = async () => {
    if (match.queue === 'ranked') {
      const q = quitNoticeText(await service.rankedMe().catch(() => null));
      if (q) return rankedQuitMessage(q);
    }
    ctx.back();
  };
  try {
    conn = await connect(o.sb, match, quarterLenOverride(), abort.signal, service);
    ({ cfg, link } = conn);
    // Ranked: both players are on the channel, so the match has started. From here a leave is a forfeit, not a dodge
    // (the heartbeat below, from the game's start, takes over).
    if (match.queue === 'ranked') void service.alive(match.id);
  } catch (e) {
    // Before leaving (which voids the match): did the other player already leave? Then that's what happened, not a
    // busy server (the channel refuses a match that's over).
    const gone = e instanceof MatchOverError
      || ((e as Error).name !== 'AbortError' && (await service.matchStatus(match.id).catch(() => 'active')) !== 'active');
    offExit();
    await service.leave(match.id);
    if ((e as Error).name === 'AbortError') return quitOrBack();
    if (gone) return message(ctx, 'OPPONENT LEFT', `${match.opponent.name} left before the game started. No result was recorded.`);
    const p = classify(e);
    return message(ctx, p.kind === 'busy' ? 'ONLINE IS BUSY' : 'NO CONNECTION', p.message);
  }

  let over = false;
  // Move gameplay to a relayed direct link if the server hands out TURN credentials (stays on Realtime otherwise).
  void iceFor(o.sb, match.id).then((ice) => {
    if (ice && !over) link.upgrade(match.side, ice.iceServers, ice.policy);
    else link.gaveUp = true;
  });

  // Before tip-off: give the direct link a moment to open, then ping the other player a few times and start with an
  // input delay that fits this link (netDelay.ts), instead of 8 ticks and climbing.
  root.innerHTML = panel('CONNECTING', 'Checking your connection…', `
    <div class="actions center"><button class="btn ghost" data-a="cancel">Cancel</button></div>`);
  root.querySelector('[data-a="cancel"]')!.addEventListener('click', () => abort.abort());
  await link.waitDirect(DIRECT_WAIT_MS);
  const probe = await link.probe();
  const startDelay = link.startDelayFor(probe);
  if (abort.signal.aborted) {
    over = true;
    offExit();
    link.close();
    await service.leave(match.id);
    return quitOrBack();
  }
  link.startMeter();

  // As soon as the game ends, each player uploads everything signed they hold, for the winner check (once per game;
  // best effort). A copy stays on this device until the server has it, and the Ranked hub retries it (evidenceQueue.ts).
  let uploaded = false;
  const uploadEvidence = () => {
    const log = link.evidence;
    const keys = conn.keys;
    if (uploaded || !log || !keys) return;
    uploaded = true;
    void (async () => {
      await log.settled(); // the last batches may still be signing
      const packed = await pack(log.evidence(conn.setup, keys));
      const offHide = uploadOnExit(match.id, packed, keepaliveRpc);
      try {
        await evidenceQueue.upload({ id: match.id, userId: service.userId, packed, createdAt: Date.now() }, service);
      } finally {
        offHide();
      }
    })().catch(() => {});
  };

  let ls: Lockstep | null = null;
  let handle: PlayHandle | null = null;
  let startedAt = 0;
  // The match's network stats, once, whichever way it ends (a finished game, a quit, the opponent leaving).
  let statsSent = false;
  const sendNetStats = () => {
    if (statsSent || !ls) return;
    statsSent = true;
    void submitNetStats(o.sb, netStatsRow(match.id, service.userId, link, ls, link.pinger.stats(), (performance.now() - startedAt) / 1000));
  };
  sayBye = () => ls?.bye();
  // Clears the intro's timers and listener if the match ends while it's still showing.
  let stopIntro = () => {};
  // While the game is on, a heartbeat: if both players vanish without a leave arriving, the server calls it off.
  void service.alive(match.id);
  const beat = setInterval(() => void service.alive(match.id), HEARTBEAT_MS);
  const end = async (title: string, note: string, peerLost = false, desync = false) => {
    if (over) return;
    over = true;
    offExit();
    if (!desync) clearInterval(beat); // a desync: still here while the server looks at it
    clearInterval(watch);
    stopIntro();
    handle?.stop();
    ls?.bye();
    sendNetStats();
    uploadEvidence();
    link.close();
    if (!peerLost || match.queue !== 'ranked') {
      await service.leave(match.id);
      if (match.queue === 'ranked' && !peerLost) {
        const q = quitNoticeText(await service.rankedMe().catch(() => null));
        if (q) return rankedQuitMessage(q, { service, match });
      }
      message(ctx, title, note, { service, match });
      return;
    }
    // Ranked, and the other player is the one who went, or the games went out of sync: I'm not a leaver, so I don't
    // leave. The server settles it, maybe through the judge.
    message(ctx, title, desync ? `${note} ${CHECKING}` : note, { service, match });
    const tag = root.querySelector('.tag');
    const say = (out: ReportOutcome | null) => {
      if (tag && out?.status === 'judging') tag.textContent = out.later ? CHECKING : STILL_CHECKING;
      else if (tag && out?.judged) tag.textContent = out.status === 'void' ? 'The server could not decide this match, so it was not rated.' : 'The server checked this match and your rank is up to date.';
    };
    void (async () => {
      let out = desync ? await service.desync(match.id) : null;
      if (!out) {
        if (desync && tag) tag.textContent = `${note} No result was recorded.`; // the server isn't judging disputes
        out = await service.claimForfeit(match.id);
      }
      say(out);
      const final = await out?.later;
      if (final) say({ ...final, later: undefined });
    })().catch(() => {}).finally(() => clearInterval(beat));
  };
  const watch = setInterval(() => {
    if (!ls || over) return;
    if (ls.problem) void (match.queue === 'ranked' ? end('GAME STOPPED', ls.problem, true, true) : end('GAME STOPPED', `${ls.problem} No result was recorded.`, true));
    else if (ls.peerLeft) void end('OPPONENT LEFT', `${match.opponent.name} left the game. No result was recorded.`, true);
    else if (performance.now() - ls.lastHeard > PEER_TIMEOUT_MS) void end('CONNECTION LOST', `Lost the connection to ${match.opponent.name}. No result was recorded.`, true);
  }, 1000);

  // The pre-game intro (both lineups), unless the other player's client predates it. Its end is a barrier: each side
  // says `ready`, the host says `go`, and only then does the game (and lockstep, with the same start delay) begin.
  if (conn.intro) {
    const votes = new IntroVotes();
    const intro = showIntro(root, {
      home: cfg.home, away: cfg.away, mySide: match.side, lengthMs: INTRO_LEN_MS, capMs: INTRO_CAP_MS, instantSkip: false,
      online: { votes, onVote: (skip) => link.sendPre(skip ? 'skip' : 'unskip') },
    });
    const gate = new PreGate(match.side, INTRO_CAP_MS, (k) => link.sendPre(k), () => {
      intro.destroy();
      link.onPre(null);
      startGame();
    });
    link.onPre((p) => {
      if (p.k === 'skip' || p.k === 'unskip') intro.peerState(p.k === 'skip');
      else gate.peer(p);
    });
    stopIntro = () => { intro.destroy(); gate.destroy(); link.onPre(null); };
    void intro.done.then(() => { if (!over) gate.localEnd(); });
  } else {
    startGame();
  }

  function startGame() {
    if (over) return;
    stopIntro = () => {};
    audio.unlock();
    root.className = 'screen-game';
    handle = playGame(root, cfg, audio, (g) => void finish(g), () => void end('LEFT GAME', 'You left the game. No result was recorded.'), {
      online: {
        viewTeam: match.side,
        start: (g) => {
          const l = (ls = new Lockstep(g, link, { side: match.side, delay: startDelay, resyncLimit: resyncLimitFor(match.queue, JUDGE_AUTHORITATIVE) }));
          startedAt = performance.now();
          link.attach(l);
          // Read-only counters for the lag tests (no ids or secrets).
          Object.defineProperty(window, '__pokejamNet', { configurable: true, get: () => ({ stalls: l.stats.stalls, stallMs: Math.round(l.stats.stallMs), delay: l.delay, rtt: Math.round(link.pinger.smooth ?? 0) }) });
        },
        ping: () => link.pinger.smooth,
        advance: (intent, dt) => ls!.advance(intent, dt),
        status: () => (ls && ls.waiting > 0.4 ? `Waiting for ${match.opponent.name}…` : null),
        idle: () => ls?.maybeSend(false),
      },
      startingFive: startingFiveEnabled('full', match.queue, true, conn.startingFive),
    });
  }

  async function finish(g: Game) {
    if (over) return;
    over = true;
    offExit();
    clearInterval(beat);
    clearInterval(watch);
    sendNetStats();
    uploadEvidence();
    const mine = g.score[match.side];
    const theirs = g.score[1 - match.side];
    const won = mine > theirs;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__pokejamOnline = { hash: ls?.hash(), score: [...g.score], side: match.side, stats: ls?.stats, delay: ls?.delay, matchId: match.id, sent: link.sent, direct: link.direct };
    // Let the last lockstep messages reach the other player before leaving the channel.
    setTimeout(() => link.close(), 3000);
    const names = match.queue === 'ranked' ? { me: match.me.name, opp: match.opponent.name } : undefined;
    let oppRank: ReportOutcome['oppRank'];
    const show = (out: ReportOutcome) => (typeof o.outcomeHtml === 'function' ? o.outcomeHtml({ ...out, names: out.names ?? names, oppRank: out.oppRank !== undefined ? out.oppRank : oppRank }) : o.outcomeHtml);
    let note: string;
    let later: Promise<ReportOutcome> | undefined;
    try {
      const opp: OnlineOpponent = { ...match.opponent, matchId: match.id, mySide: match.side };
      const out = await service.reportResult(match.queue, opp, { won, score: [mine, theirs], engineVersion: g.engineVersion, seed: g.seed, resyncs: ls?.stats.resyncs ?? 0 });
      if (match.queue === 'ranked') oppRank = (await service.matchRanks(match.id, match.side)).opp; // fails soft: no badge on an error
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
