// Quick Play: pick any gym or the Elite Four, snake-draft five Pokémon against them, pick a floor, play.
// Pure arcade: no stamina, no bench, nothing saved. Playing as My Drafted Team adds both benches (and stamina so subs matter).
import { COURTS, courtFor, userCourt, type CourtStyle } from '../data/courts';
import { POKEMON, POSITIONS, TYPE_COLORS, spriteUrl, type Mon } from '../data/pokemon';
import { LEAGUE, USER_STYLE, contrastAway, simulate, type LeagueTeam } from '../franchise/league';
import type { Audio } from '../game/audio';
import { bestLineup, teamOvr, type Game } from '../game/game';
import type { TeamDef } from '../game/types';
import { cpuRoster, draftedMons, draftedStarters, loadDrafted, renameDrafted, type TeamSource } from '../season/team';
import { inlineRename } from '../ui/teamName';
import { badgeSvg } from '../ui/badges';
import { abbr, esc, lettersName, shuffle, tier } from '../util';
import { draftScreen } from './draft';
import { bindSettings, settingsHtml, type Settings } from './menu';
import { playGame } from './play';
import { resultsScreen } from './results';
import { offlineStats } from '../telemetry/offlineStats';
import { claimUserTeam, resultTag, type GameMode } from './watch';

export interface QuickActions {
  menu(): void;
  /** Settings changed and should be saved. */
  saved(): void;
  /** Shows a full-screen busy overlay; call the returned function to remove it. */
  overlay(text: string): () => void;
}

const levelLabel = (t: LeagueTeam) =>
  t.elite ? 'Final boss' : t.gym! <= 2 ? `Gym ${t.gym} · Easier` : t.gym! >= 7 ? `Gym ${t.gym} · Tough` : `Gym ${t.gym}`;

function lineupHtml(mons: Mon[]): string {
  return `<ul class="lineup">${[...mons].sort((a, b) => POSITIONS.indexOf(a.pos) - POSITIONS.indexOf(b.pos)).map((m) =>
    `<li title="${esc(m.name)}"><img src="${spriteUrl(m.dex)}" alt=""><span>${m.pos}</span><b class="t-${tier(m.ovr)}">${m.ovr}</b></li>`).join('')}</ul>`;
}

export function quickPlay(root: HTMLElement, settings: Settings, audio: Audio, act: QuickActions, initial: TeamSource = 'draft') {
  let source: TeamSource = loadDrafted() || initial !== 'mine' ? initial : 'draft';
  /** Set while playing as My Drafted Team: its name and colors, and both benches. */
  let drafted: { name: string; color: string; color2: string; bench: Mon[]; oppBench: Mon[] } | null = null;
  /** Colors picked on the Quick Play draft-complete screen (the name goes to settings.teamName). */
  let picked: { color: string; color2: string } | null = null;
  const userName = () => drafted?.name ?? (lettersName(settings.teamName) || 'Pallet Town');
  const colors = () => (drafted ? { color: drafted.color, color2: drafted.color2 } : picked ?? {});
  const user = () => ({ name: userName(), abbr: abbr(userName()), ...USER_STYLE, ...colors(), human: true });
  /** Quick Play just uses the current name: a rename here updates it (and My Drafted Team when that's the team). */
  const rename = (name: string) => {
    if (drafted) {
      drafted.name = name;
      renameDrafted(name);
    } else {
      settings.teamName = name;
      act.saved();
    }
  };

  const sourceNote = () => source === 'mine'
    ? 'Your Season Draft ten: the best five start and the other five come off the bench. Your opponent drafts ten too.'
    : source === 'random'
      ? 'Five random Pokémon against a CPU-drafted opponent. Gym teams favor their type; the Elite Four are the toughest.'
      : 'You and your opponent snake-draft five Pokémon each. Gym teams favor their type; the Elite Four are the toughest.';

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
        <p class="note center source-note">${sourceNote()}</p>
      </div>`;
    root.querySelector('[data-a="menu"]')!.addEventListener('click', act.menu);
    root.querySelector('#source')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b || b.disabled) return;
      source = b.dataset.v as TeamSource;
      root.querySelectorAll('#source button').forEach((x) => x.classList.toggle('on', x === b));
      root.querySelector('.source-note')!.textContent = sourceNote();
    });
    root.querySelectorAll<HTMLButtonElement>('.opp').forEach((b) => b.addEventListener('click', () => {
      const i = b.dataset.i === 'random' ? Math.floor(Math.random() * LEAGUE.length) : Number(b.dataset.i);
      audio.blip(true);
      draft(LEAGUE[i]);
    }));
  }

  function draft(opp: LeagueTeam) {
    const saved = source === 'mine' ? loadDrafted() : null;
    drafted = null;
    picked = null;
    if (saved) {
      // My Drafted Team, no draft screen: its best five start and the other five come off the bench.
      // The opponent gets a CPU-drafted ten as well, so both sides tire and sub the same way.
      const all = draftedMons(saved);
      const starters = draftedStarters(saved);
      const pool = POKEMON.filter((m) => !all.includes(m));
      const theirs = bestLineup(cpuRoster(pool, 10, opp.types));
      drafted = { name: saved.name, ...saved.colors, bench: all.filter((m) => !starters.includes(m)), oppBench: theirs.bench };
      return matchup(opp, starters, theirs.starters, courtFor(opp));
    }
    if (source === 'random') {
      // No draft screen: five random Pokémon against a CPU-drafted opponent.
      const pool = POKEMON.filter(() => true);
      const picks = cpuRoster(pool, 5);
      return matchup(opp, picks, cpuRoster(pool, 5, opp.types), courtFor(opp));
    }
    root.className = 'screen-draft';
    window.scrollTo(0, 0);
    const teams = [user(), { ...opp, human: false }];
    draftScreen(root, { teams, order: shuffle([0, 1]), taken: [], rounds: 5 }, audio,
      (rosters) => {
        // The draft-complete screen can rename and recolor your team; Quick Play carries that into the game.
        if (teams[0].name !== userName()) rename(teams[0].name);
        picked = { color: teams[0].color, color2: teams[0].color2 };
        matchup(opp, rosters[0], rosters[1], courtFor(opp));
      },
      pickOpponent, () => {});
  }

  function matchup(opp: LeagueTeam, mine: Mon[], theirs: Mon[], court: CourtStyle) {
    root.className = 'screen-quick';
    window.scrollTo(0, 0);
    const venues: CourtStyle[] = [userCourt(userName()), ...Object.entries(COURTS).filter(([k]) => k !== 'Pallet Town').map(([, c]) => c)];
    const side = (name: string, color: string, sub: string, mons: Mon[], bench: Mon[] = [], mine = false) => `
      <div class="nx-team" style="--tc:${color}">
        <span class="where">${esc(sub)}</span>
        <h3 class="${mine ? 'nx-name' : ''}">${esc(name)}</h3>
        <p>${teamOvr(mons)} OVR</p>
        ${lineupHtml(mons)}
        ${bench.length ? `<p class="note nx-bench-lbl">Bench</p><div class="nx-bench">${lineupHtml(bench)}</div>` : ''}
      </div>`;
    root.innerHTML = `
      <div class="quick">
        <section class="card next">
          <p class="eyebrow">Quick Play · ${esc(court.venue)}</p>
          <div class="nx-cols">
            ${side(userName(), user().color, drafted ? 'You · My Drafted Team' : 'You', mine, drafted?.bench, true)}
            <div class="vs">VS</div>
            ${side(opp.name, opp.color, opp.elite ? 'Final boss' : `Gym Leader ${opp.leader}`, theirs, drafted?.oppBench)}
          </div>
          <div class="field venue">Venue
            <select id="venue">${venues.map((v, i) => `<option value="${i}" ${v.venue === court.venue ? 'selected' : ''}>${esc(v.venue)}</option>`).join('')}</select>
          </div>
          ${settingsHtml(settings)}
          <div class="actions center">
            <button class="btn primary big" data-a="tip">Play game</button>
            <button class="btn" data-a="watch">Watch</button>
            <button class="btn" data-a="sim">Sim game</button>
            ${drafted ? '' : '<button class="btn" data-a="redraft">Redraft</button>'}
            <button class="btn ghost" data-a="opp">New opponent</button>
          </div>
        </section>
      </div>`;
    bindSettings(root, settings, act.saved);
    inlineRename(root.querySelector<HTMLElement>('.nx-name')!, userName, rename);
    root.querySelector<HTMLSelectElement>('#venue')!.addEventListener('change', (e) => {
      matchup(opp, mine, theirs, venues[Number((e.target as HTMLSelectElement).value)]);
    });
    root.querySelector('[data-a="tip"]')!.addEventListener('click', () => play(opp, mine, theirs, court));
    root.querySelector('[data-a="watch"]')!.addEventListener('click', () => play(opp, mine, theirs, court, 'watched'));
    root.querySelector('[data-a="sim"]')!.addEventListener('click', () => play(opp, mine, theirs, court, 'simmed'));
    root.querySelector('[data-a="redraft"]')?.addEventListener('click', () => draft(opp));
    root.querySelector('[data-a="opp"]')!.addEventListener('click', pickOpponent);
  }

  function play(opp: LeagueTeam, mine: Mon[], theirs: Mon[], court: CourtStyle, mode: GameMode = 'played') {
    root.className = 'screen-game';
    audio.unlock();
    const cpu = mode !== 'played';
    const home: TeamDef = { ...user(), human: !cpu, roster: mine, ...(drafted ? { bench: drafted.bench } : {}) };
    const away = contrastAway(home, {
      name: opp.name, abbr: opp.abbr, color: opp.color, color2: opp.color2,
      roster: theirs, human: false, boost: opp.boost, coach: opp.leader, ...(drafted ? { bench: drafted.oppBench } : {}),
    });
    const cfg = { home, away, quarterLen: settings.quarterLen, difficulty: settings.difficulty, court, autoSwitch: settings.autoSwitch !== false, ...(drafted ? { stamina: true, userAutoSubs: settings.autoSubs !== false } : {}) };
    const stat = offlineStats().start('quick');
    const done = (g: Game) => {
      stat.finish(mode);
      // Watch and Sim are CPU-vs-CPU; the results screen still treats your side as the user's (headline, Share).
      if (cpu) claimUserTeam(g);
      root.className = 'screen-results';
      window.scrollTo(0, 0);
      resultsScreen(root, g, {
        tag: resultTag(`Quick Play · ${court.venue}`, mode),
        shareOpponent: court.venue,
        buttons: [
          { id: 'rematch', label: 'Rematch', kind: 'primary' },
          ...(drafted ? [] : [{ id: 'redraft', label: 'Redraft' }]),
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
    };
    if (mode === 'simmed') {
      const close = act.overlay('Simulating your game…');
      void simulate(cfg).then((g) => { close(); done(g); });
    } else {
      playGame(root, cfg, audio, done, () => matchup(opp, mine, theirs, court), mode === 'watched' ? { spectator: true } : {});
    }
  }

  pickOpponent();
}
