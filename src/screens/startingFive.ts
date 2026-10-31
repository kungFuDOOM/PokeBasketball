// "Your starting five": before tip-off, a broadcast-style intro of both teams' starters, over the court. A title card
// while the announcer opens the lineups, then the opponent's five slide in one position at a time (PG to C), then
// yours, to a cheer: "YOUR STARTING FIVE". Then the game tips off. Display only: the sim doesn't step until it's over,
// so a seeded replay is unchanged. Offline any button (or Skip) skips it. Online games can't skip it: both players see
// the same intro and tip off together.
import { spriteUrl } from '../data/pokemon';
import type { Audio } from '../game/audio';
import { teamOvr, type Game } from '../game/game';
import type { TeamId } from '../game/types';
import type { Voice } from '../game/voice';
import { esc } from '../util';

/** Seconds: the title card, each team's five, the stagger between cards, and the fade into the game. */
export const TITLE = 1.6;
export const TEAM = 3;
const STAGGER = 0.22;
const FADE = 0.45;
/** The whole intro, in seconds. */
export const INTRO_LENGTH = TITLE + 2 * TEAM + FADE;

export interface StartingFive {
  /** Advance by wall-clock `dt`; returns false once it's over (the overlay is gone by then). */
  frame(dt: number): boolean;
  skip(): void;
}

export interface StartingFiveOptions {
  audio: Audio;
  voice: Voice;
  /** The player's own team, shown last as "YOUR STARTING FIVE". Null when there isn't one (two players on one device). */
  mine: TeamId | null;
  /** False online: both players see the whole intro. */
  skippable: boolean;
}

/** The two teams in the order they're introduced: the opponent first and yours last, else away then home. */
export function introOrder(mine: TeamId | null): [TeamId, TeamId] {
  return mine === null ? [1, 0] : [(1 - mine) as TeamId, mine];
}

let lastOpen = '';

/** "Ladies and gentlemen, your starting lineups!" (one of two, never the same twice in a row). */
function openLine(): string {
  const pick = ['lineups_1', 'lineups_2'].filter((c) => c !== lastOpen);
  lastOpen = pick[Math.floor(Math.random() * pick.length)];
  return lastOpen;
}

function teamHtml(g: Game, t: TeamId, mine: boolean): string {
  const def = g.teams[t];
  const five = g.players.filter((p) => p.team === t).sort((a, b) => a.slot - b.slot);
  const cards = five.map((p, i) => `
    <li class="s5-card" style="--d:${(0.35 + i * STAGGER).toFixed(2)}s">
      <b>${p.mon.pos}</b>
      <img alt="" src="${spriteUrl(p.mon.dex)}">
      <span>${esc(p.mon.name)}</span>
      <i>${p.mon.ovr}</i>
    </li>`).join('');
  return `
    <section class="s5-team${mine ? ' mine' : ''}" data-t="${t}" style="--tc:${def.color};--tc2:${def.color2}">
      <header class="s5-head"><small>${mine ? 'Your starting five' : 'Starting five'}</small><strong>${esc(def.name)}</strong><em>OVR ${teamOvr(def.roster)}</em></header>
      <ol class="s5-row">${cards}</ol>
    </section>`;
}

export function startingFive(parent: HTMLElement, g: Game, o: StartingFiveOptions): StartingFive {
  const [first, last] = introOrder(o.mine);
  const [home, away] = g.teams;
  const el = document.createElement('div');
  el.className = 's5';
  el.innerHTML = `
    <div class="s5-bar top"></div><div class="s5-bar bottom"></div>
    <div class="s5-title"><small>${esc(away.name)} <i>vs</i> ${esc(home.name)}</small><strong>Starting lineups</strong></div>
    ${teamHtml(g, first, first === o.mine)}
    ${teamHtml(g, last, last === o.mine)}
    ${o.skippable ? '<button class="s5-skip" type="button">Skip ▸</button>' : ''}`;
  parent.appendChild(el);
  el.querySelector('.s5-skip')?.addEventListener('click', () => skip());
  const [a, b] = [...el.querySelectorAll<HTMLElement>('.s5-team')];

  let t = 0;
  let stage = -1;
  let done = false;
  /** Card thumps already played, per team. */
  const thumps = [0, 0];
  requestAnimationFrame(() => el.classList.add('in'));
  // His clips may still be loading on a first game: the opening line waits a moment for them, then goes unsaid.
  const open = openLine();
  let opened = false;

  const show = (team: HTMLElement, mine: boolean) => {
    el.classList.remove('title');
    team.classList.add('show');
    if (mine) {
      o.voice.say('yourfive');
      o.audio.play('swish'); // the crowd goes up for the home side
    }
  };

  function skip() {
    if (!o.skippable || done) return;
    t = Math.max(t, INTRO_LENGTH - FADE);
  }

  return {
    skip,
    frame(dt: number) {
      if (done) return false;
      t += dt;
      if (!opened && t < 0.8 && o.voice.length(open) > 0) { opened = true; o.voice.say(open); }
      const next = t < TITLE ? 0 : t < TITLE + TEAM ? 1 : t < TITLE + 2 * TEAM ? 2 : t < INTRO_LENGTH ? 3 : 4;
      while (stage < next) {
        stage++;
        if (stage === 0) el.classList.add('title');
        if (stage === 1) show(a, first === o.mine);
        if (stage === 2) { a.classList.replace('show', 'gone'); show(b, last === o.mine); }
        if (stage === 3) el.classList.add('out');
      }
      // A thump as each card lands (only while its team is on screen).
      if (stage === 1 || stage === 2) {
        const i = stage - 1;
        const since = t - (stage === 1 ? TITLE : TITLE + TEAM);
        while (thumps[i] < 5 && since >= 0.35 + thumps[i] * STAGGER + 0.15) { thumps[i]++; o.audio.play('catch'); }
      }
      if (stage >= 4) {
        done = true;
        el.remove();
        return false;
      }
      return true;
    },
  };
}
