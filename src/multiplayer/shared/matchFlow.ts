// Common queue → match found → play (or sim) → result flow, used by Social and Ranked.
import { userCourt } from '../../data/courts';
import { spriteUrl, type Mon } from '../../data/pokemon';
import { USER_STYLE, contrastAway } from '../../franchise/league';
import { ENGINE_VERSION, type Difficulty, type TeamDef } from '../../game/types';
import { withIntro } from '../../screens/intro';
import { startingFiveEnabled } from '../../screens/intro.logic';
import { playGame } from '../../screens/play';
import { resultsScreen } from '../../screens/results';
import { abbr, esc } from '../../util';
import type { MatchService, Opponent, Queue, ReportOutcome } from './matchService';
import { randomFive, rostersFor, teamOvr } from './roster';
import type { ModeContext } from './types';

export { randomFive } from './roster';

const diffFor = (mmr: number): Difficulty => (mmr < 900 ? 'rookie' : mmr < 1400 ? 'pro' : mmr < 1900 ? 'allstar' : 'legend');

export function panel(title: string, tag: string, inner = ''): string {
  return `<div class="menu"><header class="title"><h1 class="logo"><span class="logo-jam">${esc(title)}</span></h1>
    <p class="tag">${esc(tag)}</p></header>${inner ? `<section class="card setup">${inner}</section>` : ''}</div>`;
}

export interface FlowOptions {
  queue: Queue;
  service: MatchService;
  /** HTML shown after a match: rank change for Ranked, a plain note for Social. */
  outcomeHtml(out: ReportOutcome): string;
  /** A CPU game that never touches a rating (Ranked's fallback when no opponent is found): labelled as practice. */
  practice?: boolean;
}

export async function runMatch(ctx: ModeContext, opts: FlowOptions) {
  const { root } = ctx;
  const label = opts.practice ? 'Practice' : opts.queue === 'ranked' ? 'Ranked' : 'Social';
  root.className = 'screen-menu';
  root.innerHTML = panel('SEARCHING', opts.practice ? 'Finding a CPU opponent…' : `Finding a ${label.toLowerCase()} opponent near your skill…`);
  const opp = await opts.service.findMatch(opts.queue);
  // Ranked: two evenly matched teams from a seed (roster.ts), shown before tip-off. Social: random fives.
  const name = ctx.settings.teamName.trim() || 'Pallet Town';
  const rosters: [Mon[], Mon[]] = opts.queue === 'ranked' ? rostersFor((Math.random() * 2 ** 32) >>> 0, 'ranked') : [randomFive(), randomFive()];
  root.innerHTML = panel('MATCH FOUND', `${opp.name} · ${label}${opp.simulated ? ' · simulated' : ''}`, `
    ${opts.queue === 'ranked' ? teamsHtml(name, opp.name, rosters) : ''}
    <div class="actions center">
      <button class="btn primary big" data-a="play">Tip off</button>
      ${import.meta.env.DEV ? '<button class="btn" data-a="sim">Sim result (test)</button>' : ''}
      <button class="btn ghost" data-a="back">Cancel</button>
    </div>`);
  root.querySelector('[data-a="back"]')!.addEventListener('click', ctx.back);
  // Dev builds only: a made-up result must never be reportable from a real build.
  root.querySelector('[data-a="sim"]')?.addEventListener('click', async () => {
    const won = Math.random() < 0.5;
    const out = await opts.service.reportResult(opts.queue, opp, { won, score: won ? [42, 38] : [38, 42], engineVersion: ENGINE_VERSION });
    root.innerHTML = panel(won ? 'YOU WIN' : 'YOU LOSE', 'Simulated result', `${opts.outcomeHtml(out)}
      <div class="actions center"><button class="btn primary" data-a="hub">Back</button></div>`);
    root.querySelector('[data-a="hub"]')!.addEventListener('click', ctx.back);
  });
  root.querySelector('[data-a="play"]')!.addEventListener('click', () => play(ctx, opts, opp, rosters));
}

/** Both starting fives side by side, with each team's total OVR (Ranked's are within a few points of each other). */
export function teamsHtml(myName: string, theirName: string, [mine, theirs]: [Mon[], Mon[]]): string {
  const side = (title: string, team: Mon[]) => `<div class="mp-team">
      <h3>${esc(title)}<span>${teamOvr(team)} OVR</span></h3>
      <ul>${team.map((m) => `<li><img src="${spriteUrl(m.dex)}" alt=""><b>${esc(m.pos)}</b><span>${esc(m.name)}</span><i>${m.ovr}</i></li>`).join('')}</ul>
    </div>`;
  return `<div class="mp-teams">${side(myName, mine)}<div class="mp-vs">VS</div>${side(theirName, theirs)}</div>
    <p class="note center">Evenly matched teams: total OVR within a few points, and no team is top-heavy. Legendaries like Mewtwo sit out of Ranked.</p>`;
}

function play(ctx: ModeContext, opts: FlowOptions, opp: Opponent, [mine, theirs]: [Mon[], Mon[]]) {
  const { root, settings, audio } = ctx;
  audio.unlock();
  root.className = 'screen-game';
  const name = settings.teamName.trim() || 'Pallet Town';
  const home: TeamDef = { name, abbr: abbr(name), ...USER_STYLE, human: true, roster: mine };
  const away = contrastAway(home, { name: opp.name, abbr: abbr(opp.name), color: '#7a3fd8', color2: '#24124a', human: false, roster: theirs });
  const cfg = { home, away, quarterLen: settings.quarterLen, difficulty: diffFor(opp.mmr), court: userCourt(name), autoSwitch: settings.autoSwitch !== false };
  const introCtx = opts.practice ? 'cpu' : opts.queue;
  const startingFive = startingFiveEnabled(settings.introMode ?? 'full', introCtx, false, false);
  withIntro(root, cfg, introCtx, settings, () => playGame(root, cfg, audio, async (g) => {
    const won = g.score[0] > g.score[1];
    const out = await opts.service.reportResult(opts.queue, opp, { won, score: [g.score[0], g.score[1]], engineVersion: g.engineVersion, seed: g.seed });
    root.className = 'screen-results';
    window.scrollTo(0, 0);
    resultsScreen(root, g, {
      tag: opts.practice ? 'Practice match (unranked)' : opts.queue === 'ranked' ? 'Ranked match' : 'Social match',
      extraHtml: opts.outcomeHtml(out),
      buttons: [{ id: 'again', label: 'Play again', kind: 'primary' }, { id: 'hub', label: 'Back', kind: 'ghost' }],
      onAction: (a) => (a === 'again' ? runMatch(ctx, opts) : ctx.back()),
    });
  }, ctx.back, { startingFive }));
}
