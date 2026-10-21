// Quick Play: pick any gym or the Elite Four, snake-draft five Pokémon against them, pick a floor, play.
// Pure arcade: no stamina, no bench, nothing saved.
import { COURTS, courtFor, userCourt, type CourtStyle } from '../data/courts';
import { POKEMON, POSITIONS, TYPE_COLORS, spriteUrl, type Mon } from '../data/pokemon';
import { LEAGUE, USER_STYLE, contrastAway, type LeagueTeam } from '../franchise/league';
import type { Audio } from '../game/audio';
import { teamOvr } from '../game/game';
import type { TeamDef } from '../game/types';
import { cpuRoster, draftedStarters, loadDrafted, type TeamSource } from '../season/team';
import { badgeSvg } from '../ui/badges';
import { abbr, esc, shuffle, tier } from '../util';
import { draftScreen } from './draft';
import { bindSettings, settingsHtml, type Settings } from './menu';
import { playGame } from './play';
import { resultsScreen } from './results';

export interface QuickActions {
  menu(): void;
  /** Settings changed and should be saved. */
  saved(): void;
}

const levelLabel = (t: LeagueTeam) =>
  t.elite ? 'Final boss' : t.gym! <= 2 ? `Gym ${t.gym} · Easier` : t.gym! >= 7 ? `Gym ${t.gym} · Tough` : `Gym ${t.gym}`;

function lineupHtml(mons: Mon[]): string {
  return `<ul class="lineup">${[...mons].sort((a, b) => POSITIONS.indexOf(a.pos) - POSITIONS.indexOf(b.pos)).map((m) =>
    `<li title="${esc(m.name)}"><img src="${spriteUrl(m.dex)}" alt=""><span>${m.pos}</span><b class="t-${tier(m.ovr)}">${m.ovr}</b></li>`).join('')}</ul>`;
}

export function quickPlay(root: HTMLElement, settings: Settings, audio: Audio, act: QuickActions, initial: TeamSource = 'draft') {
  let source: TeamSource = loadDrafted() || initial !== 'mine' ? initial : 'draft';
  const userName = () => settings.teamName.trim() || 'Pallet Town';
  const user = () => ({ name: userName(), abbr: abbr(userName()), ...USER_STYLE, human: true });

  function pickOpponent() {
    root.className = 'screen-quick';
    window.scrollTo(0, 0);
    root.innerHTML = `
      <div class="quick">
        <header class="draft-head">
          <button class="btn ghost small" data-a="menu">Menu</button>
          <div class="status"><span class="round">QUICK PLAY</span><span class="otc">Pick your opponent</span></div>
        </header>
        <ul class="opp-grid">
          ${LEAGUE.map((t, i) => `
            <li><button class="opp" data-i="${i}" style="--tc:${t.color}">
              ${badgeSvg(t.elite ? 'Elite' : t.badge!, true, 56)}
              <span class="opp-lvl">${levelLabel(t)}</span>
              <strong>${esc(t.name)}</strong>
              <span class="opp-leader">${esc(t.leader)}</span>
              <span class="types">${t.types.map((ty) => `<i style="--tc:${TYPE_COLORS[ty]}">${ty}</i>`).join('')}</span>
            </button></li>`).join('')}
          <li><button class="opp random" data-i="random">
            <span class="opp-q">?</span>
            <span class="opp-lvl">Surprise me</span>
            <strong>Random opponent</strong>
          </button></li>
        </ul>
        <div class="field source-pick">Your team
          <div class="seg" id="source">
            <button data-v="draft" class="${source === 'draft' ? 'on' : ''}">Draft</button>
            <button data-v="mine" class="${source === 'mine' ? 'on' : ''}" ${loadDrafted() ? '' : 'disabled title="Finish a Season Draft first"'}>My Drafted Team</button>
            <button data-v="random" class="${source === 'random' ? 'on' : ''}">Random</button>
          </div>
        </div>
        <p class="note center">You and your opponent snake-draft five Pokémon each. Gym teams favor their type; the Elite Four are the toughest.</p>
      </div>`;
    root.querySelector('[data-a="menu"]')!.addEventListener('click', act.menu);
    root.querySelector('#source')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b || b.disabled) return;
      source = b.dataset.v as TeamSource;
      root.querySelectorAll('#source button').forEach((x) => x.classList.toggle('on', x === b));
    });
    root.querySelectorAll<HTMLButtonElement>('.opp').forEach((b) => b.addEventListener('click', () => {
      const i = b.dataset.i === 'random' ? Math.floor(Math.random() * LEAGUE.length) : Number(b.dataset.i);
      audio.blip(true);
      draft(LEAGUE[i]);
    }));
  }

  function draft(opp: LeagueTeam) {
    const saved = source === 'mine' ? loadDrafted() : null;
    if (source === 'random' || saved) {
      // No draft screen: your five (best starters of the drafted ten, or random) against a CPU-drafted opponent.
      const mine = saved ? draftedStarters(saved) : null;
      const pool = POKEMON.filter((m) => !mine?.includes(m));
      const picks = mine ?? cpuRoster(pool, 5);
      return matchup(opp, picks, cpuRoster(pool, 5, opp.types), courtFor(opp));
    }
    root.className = 'screen-draft';
    window.scrollTo(0, 0);
    const teams = [user(), { ...opp, human: false }];
    draftScreen(root, { teams, order: shuffle([0, 1]), taken: [], rounds: 5 }, audio,
      (rosters) => matchup(opp, rosters[0], rosters[1], courtFor(opp)),
      pickOpponent, () => {}, { customize: false });
  }

  function matchup(opp: LeagueTeam, mine: Mon[], theirs: Mon[], court: CourtStyle) {
    root.className = 'screen-quick';
    window.scrollTo(0, 0);
    const venues: CourtStyle[] = [userCourt(userName()), ...Object.entries(COURTS).filter(([k]) => k !== 'Pallet Town').map(([, c]) => c)];
    const side = (name: string, color: string, sub: string, mons: Mon[]) => `
      <div class="nx-team" style="--tc:${color}">
        <span class="where">${esc(sub)}</span>
        <h3>${esc(name)}</h3>
        <p>${teamOvr(mons)} OVR</p>
        ${lineupHtml(mons)}
      </div>`;
    root.innerHTML = `
      <div class="quick">
        <section class="card next">
          <p class="eyebrow">Quick Play · ${esc(court.venue)}</p>
          <div class="nx-cols">
            ${side(userName(), USER_STYLE.color, 'You', mine)}
            <div class="vs">VS</div>
            ${side(opp.name, opp.color, opp.elite ? 'Final boss' : `Gym Leader ${opp.leader}`, theirs)}
          </div>
          <div class="field venue">Venue
            <select id="venue">${venues.map((v, i) => `<option value="${i}" ${v.venue === court.venue ? 'selected' : ''}>${esc(v.venue)}</option>`).join('')}</select>
          </div>
          ${settingsHtml(settings)}
          <div class="actions center">
            <button class="btn primary big" data-a="tip">Tip off</button>
            <button class="btn" data-a="redraft">Redraft</button>
            <button class="btn ghost" data-a="opp">New opponent</button>
          </div>
        </section>
      </div>`;
    bindSettings(root, settings, act.saved);
    root.querySelector<HTMLSelectElement>('#venue')!.addEventListener('change', (e) => {
      matchup(opp, mine, theirs, venues[Number((e.target as HTMLSelectElement).value)]);
    });
    root.querySelector('[data-a="tip"]')!.addEventListener('click', () => play(opp, mine, theirs, court));
    root.querySelector('[data-a="redraft"]')!.addEventListener('click', () => draft(opp));
    root.querySelector('[data-a="opp"]')!.addEventListener('click', pickOpponent);
  }

  function play(opp: LeagueTeam, mine: Mon[], theirs: Mon[], court: CourtStyle) {
    root.className = 'screen-game';
    audio.unlock();
    const home: TeamDef = { ...user(), roster: mine };
    const away = contrastAway(home, {
      name: opp.name, abbr: opp.abbr, color: opp.color, color2: opp.color2,
      roster: theirs, human: false, boost: opp.boost, coach: opp.leader,
    });
    playGame(root, { home, away, quarterLen: settings.quarterLen, difficulty: settings.difficulty, court, autoSwitch: settings.autoSwitch !== false }, audio, (g) => {
      root.className = 'screen-results';
      window.scrollTo(0, 0);
      resultsScreen(root, g, {
        tag: `Quick Play · ${court.venue}`,
        buttons: [
          { id: 'rematch', label: 'Rematch', kind: 'primary' },
          { id: 'redraft', label: 'Redraft' },
          { id: 'opp', label: 'New opponent' },
          { id: 'menu', label: 'Main menu', kind: 'ghost' },
        ],
        onAction: (a) => {
          if (a === 'rematch') play(opp, mine, theirs, court);
          else if (a === 'redraft') draft(opp);
          else if (a === 'opp') pickOpponent();
          else act.menu();
        },
      });
    }, () => matchup(opp, mine, theirs, court));
  }

  pickOpponent();
}
