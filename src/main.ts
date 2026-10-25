import './compat';
import './fonts.css';
import './style.css';
import { monByDex, spriteUrl, type Mon } from './data/pokemon';
import {
  LEAGUE, USER_STYLE, advance, badgesEarned, createFranchise, gameConfig, loadDraft, loadFranchise, recordGame, startRookieDraft, saveDraft, saveFranchise,
  simulate, weekGames, weekLabel, type FGame, type Franchise, type Progress,
} from './franchise/league';
import { Audio } from './game/audio';
import { Music, trackFor } from './music/music';
import { musicToggle } from './ui/musicToggle';
import { DIFFICULTIES, type Difficulty } from './game/types';
import type { Game } from './game/game';
import { draftScreen, type DraftState } from './screens/draft';
import { shouldShowChampionship, shouldShowNewSeason } from './franchise/moments';
import { hubScreen } from './screens/hub';
import { championshipScreen, newSeasonScreen } from './screens/moments';
import { menuScreen, type Settings } from './screens/menu';
import { playGame } from './screens/play';
import { quickPlay } from './screens/quick';
import { resultsScreen } from './screens/results';
import { rookieScreen } from './screens/rookies';
import { rosterScreen } from './screens/roster';
import { seasonMode, sharedScreen } from './screens/season';
import { shareFromHash } from './season/share';
import { autoDraft, draftedMons, loadDrafted, renameDrafted, type TeamSource } from './season/team';
import { confirmNewDraft } from './ui/newDraft';
import { confirmFranchiseName } from './ui/teamName';
import { gamesScreen } from './screens/games';
import { badgeSvg } from './ui/badges';
import { guardZoom } from './ui/noZoom';
import { abbr, esc, guardNameInputs, lettersName, shuffle } from './util';

const app = document.querySelector<HTMLElement>('#app')!;
const audio = new Audio();
const music = new Music();

const settings: Settings = { difficulty: 'pro', quarterLen: 120, teamName: 'Pallet Town' };
try {
  // Only known settings with the right types are read back from storage.
  const saved = JSON.parse(localStorage.getItem('pokejam.settings') ?? '{}') as Partial<Record<keyof Settings, unknown>>;
  if (typeof saved.difficulty === 'string' && saved.difficulty in DIFFICULTIES) settings.difficulty = saved.difficulty as Difficulty;
  if (typeof saved.quarterLen === 'number' && [60, 120, 180, 300].includes(saved.quarterLen)) settings.quarterLen = saved.quarterLen;
  if (typeof saved.teamName === 'string') settings.teamName = saved.teamName.slice(0, 20);
  if (typeof saved.autoSubs === 'boolean') settings.autoSubs = saved.autoSubs;
  if (typeof saved.autoSwitch === 'boolean') settings.autoSwitch = saved.autoSwitch;
} catch { /* storage unavailable */ }
const save = () => {
  try {
    localStorage.setItem('pokejam.settings', JSON.stringify(settings));
  } catch { /* storage unavailable */ }
};

let franchise: Franchise | null = loadFranchise();

// A sprite <img> that fails to load (a host hiccup) gets one retry before it shows as missing.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || img.dataset.retried || !img.src.includes('/sprites/')) return;
  img.dataset.retried = '1';
  const src = img.src;
  window.setTimeout(() => { img.src = `${src}${src.includes('?') ? '&' : '?'}r=1`; }, 700);
}, true);

// Browsers only allow audio after a gesture.
guardNameInputs();
guardZoom();
// iPhone Safari only unlocks Web Audio inside certain gestures, so every kind of tap tries.
const unlock = () => {
  audio.unlock();
  music.attach(audio.context);
};
for (const ev of ['pointerdown', 'touchend', 'click', 'keydown']) window.addEventListener(ev, unlock, { passive: true });

// Background music follows the screen: each screen sets #app's class.
const musicBtn = musicToggle(music, unlock);
const syncTrack = () => {
  music.setTrack(trackFor(app.className));
  // Games keep their own sound toggle in the pause menu, and that corner belongs to the pause button.
  musicBtn.hidden = app.classList.contains('screen-game');
  // Draft boards and the franchise hub have buttons in that corner, so the music button joins them there;
  // elsewhere it floats top-right.
  const dock = app.querySelector('.draft-head .head-actions, .hub-head');
  if (dock) {
    if (musicBtn.parentElement !== dock) dock.appendChild(musicBtn);
  } else if (musicBtn.parentElement !== document.body) document.body.appendChild(musicBtn);
  musicBtn.classList.toggle('docked', !!dock);
};
new MutationObserver(syncTrack).observe(app, { attributes: true, attributeFilter: ['class'], childList: true });
syncTrack();


function overlay(text: string): () => void {
  const el = document.createElement('div');
  el.className = 'sim-overlay';
  el.innerHTML = `<div class="ball-spin" aria-hidden="true"></div><p>${esc(text)}</p>`;
  document.body.appendChild(el);
  return () => el.remove();
}

function draftSummary(d: DraftState): string {
  const me = d.teams.findIndex((t) => t.human);
  const n = d.taken.length;
  const mine = Array.from({ length: n }, (_, i) => i).filter((i) => {
    const round = Math.floor(i / d.order.length);
    const order = round % 2 ? [...d.order].reverse() : d.order;
    return order[i % d.order.length] === me;
  }).length;
  const rounds = d.rounds ?? 5;
  return `${d.teams[me].name} · Pick ${n + 1} of ${d.order.length * rounds} · ${mine}/${rounds} drafted`;
}

function menu() {
  app.className = 'screen-menu';
  const f = franchise;
  const d = loadDraft();
  const dt = loadDrafted();
  menuScreen(app, settings, save, {
    saved: f ? `${f.teams[0].name} · Season ${f.season} · ${f.phase === 'done' ? 'Offseason' : weekLabel(f)} · ${f.teams[0].w}-${f.teams[0].l}` : null,
    draft: d ? draftSummary(d) : null,
    drafted: dt ? `${dt.name}${dt.record ? ` · ${dt.record.w}-${dt.record.l}` : ''}${dt.rank ? ` · #${dt.rank}` : ''}` : null,
    onContinue: hub,
    onDeleteData: () => {
      try {
        for (const k of Object.keys(localStorage)) if (k.startsWith('pokejam.')) localStorage.removeItem(k);
      } catch { /* storage unavailable: nothing was saved */ }
      franchise = null;
      Object.assign(settings, { difficulty: 'pro', quarterLen: 120, teamName: 'Pallet Town' });
      menu();
      const status = app.querySelector('.foot-status');
      if (status) status.textContent = 'All saved data on this device was deleted.';
    },
    onRoster: () => {
      app.className = 'screen-roster';
      window.scrollTo(0, 0);
      rosterScreen(app, menu);
    },
    onQuick: () => quick('draft'),
    onSeason: season,
    confirmSeason: () => guardNewDraft(menu),
    onResumeDraft: () => {
      const saved = loadDraft();
      if (saved) draft(saved);
    },
    onNew: (source) => {
      audio.unlock();
      const name = lettersName(settings.teamName) || 'Pallet Town';
      const teams = [
        { name, abbr: abbr(name), ...USER_STYLE, human: true },
        ...LEAGUE.map((t) => ({ ...t, human: false })),
      ];
      const mine = source === 'mine' ? loadDrafted() : null;
      if (source === 'draft' || (source === 'mine' && !mine)) {
        saveDraft(null);
        return draft({ teams, order: shuffle(teams.map((_, i) => i)), taken: [], rounds: 10 });
      }
      // My Drafted Team or Random: no draft screen. The CPU teams fill their rosters from what's left.
      const { rosters, leftovers } = autoDraft(teams, 10, mine ? draftedMons(mine) : undefined);
      void startFranchise(teams, rosters, leftovers, { fromDrafted: !!mine, onCancel: menu });
    },
  });
}

function quick(source: TeamSource) {
  audio.unlock();
  app.className = 'screen-quick';
  quickPlay(app, settings, audio, { menu, saved: save }, source);
}

/** Franchise with My Drafted Team (its name and colors); `onCancel` runs if the name confirm is cancelled. */
function franchiseWithDrafted(onCancel: () => void) {
  const mine = loadDrafted();
  const name = mine?.name ?? (lettersName(settings.teamName) || 'Pallet Town');
  const teams = [
    { name, abbr: abbr(name), ...USER_STYLE, ...(mine ? mine.colors : {}), human: true },
    ...LEAGUE.map((t) => ({ ...t, human: false })),
  ];
  const { rosters, leftovers } = autoDraft(teams, 10, mine ? draftedMons(mine) : undefined);
  void startFranchise(teams, rosters, leftovers, { fromDrafted: !!mine, onCancel });
}

/**
 * Before a new Season Draft while a team is saved: "Start a new draft? This will replace your saved team."
 * Resolves to what to run next, or null for Keep my team (stay put, nothing changes). No saved team, no dialog.
 * `onFranchiseCancel` is where a cancelled franchise name confirm lands after leaving the current screen.
 */
async function guardNewDraft(onFranchiseCancel: () => void): Promise<(() => void) | null> {
  const choice = await confirmNewDraft();
  if (choice === 'new') return season;
  if (choice === 'quick') return () => quick('mine');
  if (choice === 'franchise') return () => franchiseWithDrafted(onFranchiseCancel);
  return null;
}

function season() {
  audio.unlock();
  seasonMode(app, settings, audio, {
    menu,
    useTeam: (mode) => {
      if (mode === 'quick') return quick('mine');
      // Cancel leaves you on the results screen with nothing changed.
      franchiseWithDrafted(() => {});
    },
  });
}

function draft(state: DraftState) {
  app.className = 'screen-draft';
  window.scrollTo(0, 0);
  draftScreen(app, state, audio, (rosters, leftovers) => {
    // Cancel keeps the finished draft saved (Continue draft on the menu brings it back) and starts nothing.
    void startFranchise(state.teams, rosters, leftovers, { fromDrafted: false, onCancel: menu });
  }, menu, saveDraft);
}

/**
 * Every new franchise starts here: "Are you sure you want this name?" (editable, and with the replace-save
 * warning when there is one), then the league is created. Cancel changes nothing.
 */
async function startFranchise(
  teams: DraftState['teams'], rosters: Parameters<typeof createFranchise>[1], leftovers: Parameters<typeof createFranchise>[2],
  opts: { fromDrafted: boolean; onCancel: () => void },
) {
  const me = teams.findIndex((t) => t.human);
  const picked = await confirmFranchiseName({ name: teams[me].name, replacing: !!franchise });
  if (!picked) return opts.onCancel();
  const { name } = picked;
  teams[me].name = name;
  teams[me].abbr = picked.abbr;
  settings.teamName = name;
  save();
  if (opts.fromDrafted) renameDrafted(name);
  franchise = createFranchise(teams, rosters, leftovers);
  saveFranchise(franchise);
  saveDraft(null);
  hub();
}

function hub() {
  const f = franchise;
  if (!f) return menu();
  app.className = 'screen-hub';
  window.scrollTo(0, 0);
  // Once per season: the title cutscene after the final, then the preview when the new season starts.
  if (shouldShowChampionship(f)) {
    championshipScreen(f, () => {
      f.titleShown = f.season;
      saveFranchise(f);
      hub();
    });
  } else if (shouldShowNewSeason(f)) {
    newSeasonScreen(f, () => {
      f.introShown = f.season;
      saveFranchise(f);
      hub();
    });
  }
  hubScreen(app, f, settings, {
    play: (g) => playUserGame(f, g),
    simMine: (g) => void simUserGame(f, g),
    simWeek: () => void finishWeek(f).then(hub),
    games: () => {
      app.className = 'screen-results';
      gamesScreen(app, f, hub);
    },
    rookies: () => {
      startRookieDraft(f);
      saveFranchise(f);
      app.className = 'screen-draft';
      window.scrollTo(0, 0);
      rookieScreen(app, f, audio, { done: hub, menu, saved: () => saveFranchise(f) });
    },
    menu,
    saved: () => {
      save();
      saveFranchise(f);
    },
  });
}

/** Sims every game still open this week, then moves the league forward. */
/** Sims every game still open this week. */
async function simRestOfWeek(f: Franchise) {
  const open = weekGames(f).filter((g) => !g.score);
  if (!open.length) return;
  const done = overlay('Simulating around the league…');
  for (const g of open) {
    const { cfg, sides, uidOf } = gameConfig(f, g, false, settings.quarterLen, settings.difficulty);
    recordGame(f, g, await simulate(cfg), sides, uidOf);
  }
  saveFranchise(f);
  done();
}

/** Sims every game still open this week, then moves the league forward. */
async function finishWeek(f: Franchise) {
  await simRestOfWeek(f);
  advance(f);
  saveFranchise(f);
}

function playUserGame(f: Franchise, g: FGame) {
  app.className = 'screen-game';
  audio.unlock();
  const { cfg, sides, uidOf } = gameConfig(f, g, true, settings.quarterLen, settings.difficulty, settings.autoSubs !== false);
  cfg.autoSwitch = settings.autoSwitch !== false;
  playGame(app, cfg, audio, (game) => void afterUserGame(f, g, game, sides, uidOf, false), hub, {
    onAutoSubs: (on) => {
      settings.autoSubs = on;
      save();
    },
  });
}

async function simUserGame(f: Franchise, g: FGame) {
  const { cfg, sides, uidOf } = gameConfig(f, g, false, settings.quarterLen, settings.difficulty);
  const done = overlay('Simulating your game…');
  const game = await simulate(cfg);
  done();
  void afterUserGame(f, g, game, sides, uidOf, true);
}

function progressHtml(f: Franchise, progress: Progress[]): string {
  const mine = progress.filter((p) => p.team === 0);
  if (!mine.length) return '';
  const evos = mine.filter((p) => p.evolvedTo).map((p) => {
    const to = monByDex(p.evolvedTo!).name.toUpperCase();
    const from = p.name.toUpperCase();
    return `
      <div class="evo">
        <div class="evo-anim"><img class="from" src="${spriteUrl(p.evolvedFrom!)}" alt="${esc(p.name)}"><img class="to" src="${spriteUrl(p.evolvedTo!)}" alt="${esc(to)}"></div>
        <p class="evo-1">What? ${esc(from)} is evolving!</p>
        <p class="evo-2">Congratulations! Your ${esc(from)} evolved into ${esc(to)}!</p>
      </div>`;
  }).join('');
  const levels = mine.map((p) => {
    const dex = p.evolvedTo ?? f.players[p.uid].dex;
    return `<li><img src="${spriteUrl(dex)}" alt=""><span><b>${esc(p.name)}</b> grew to Lv ${p.level}</span><small>${esc(p.gains.join(', ') || 'Ratings maxed')}</small></li>`;
  }).join('');
  return `<section class="progress"><h3>Level ups</h3>${evos}<ul class="levels">${levels}</ul></section>`;
}

/** Pokémon-style announcement for a badge (or the Elite Four emblem) won in this game. */
function badgeHtml(f: Franchise, teamId: number): string {
  const t = f.teams[teamId];
  const leader = (t.leader ?? t.name).toUpperCase();
  const line = t.elite
    ? `You defeated ${leader}!`
    : `You beat GYM LEADER ${leader} and earned the ${t.badge!.toUpperCase()} BADGE!`;
  return `
    <section class="badge-won" style="--tc:${t.color}">
      ${badgeSvg(t.elite ? 'Elite' : t.badge!, true, 96)}
      <p>${esc(line)}</p>
    </section>`;
}

async function afterUserGame(f: Franchise, g: FGame, game: Game, sides: [number, number], uidOf: Map<Mon, string>, simmed: boolean) {
  const before = badgesEarned(f);
  const progress = recordGame(f, g, game, sides, uidOf);
  const newBadge = [...badgesEarned(f)].find((id) => !before.has(id));
  saveFranchise(f);
  // Finish the rest of the week now, so every result and box score is there to browse from this screen.
  await simRestOfWeek(f);
  const won = game.score[0] > game.score[1];
  const label = g.round === 'final' ? 'The Final' : g.round === 'semi' ? 'Semifinal' : weekLabel(f);
  const show = () => {
    app.className = 'screen-results';
    window.scrollTo(0, 0);
    resultsScreen(app, game, {
      tag: simmed ? `${label} · Simulated` : label,
      headline: won ? (g.round === 'final' ? 'Champions!' : 'You win!') : `${f.teams[sides[1]].name} win`,
      extraHtml: (newBadge !== undefined ? badgeHtml(f, newBadge) : '') + progressHtml(f, progress),
      buttons: [
        { id: 'continue', label: 'Continue', kind: 'primary' },
        { id: 'games', label: `All ${g.round ? 'playoff' : 'week'} games` },
      ],
      onAction: (a) => {
        if (a === 'games') gamesScreen(app, f, show, 'Back to your game', g.week);
        else void finishWeek(f).then(hub);
      },
    });
  };
  show();
}

// A share link (#s=...) opens the shared team's card first.
const shared = shareFromHash(location.hash);
const clearHash = () => history.replaceState(null, '', location.pathname + location.search);
if (shared) {
  sharedScreen(app, shared, {
    menu: () => { clearHash(); menu(); },
    draftOwn: async () => {
      const go = await guardNewDraft(() => {});
      if (go) { clearHash(); go(); }
    },
  });
} else menu();
