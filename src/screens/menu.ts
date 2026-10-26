import { POKEMON, spriteUrl } from '../data/pokemon';
import { DIFFICULTIES, type Difficulty } from '../game/types';
import type { TeamSource } from '../season/team';
import { esc, lettersName } from '../util';
import { prefersStatic, startAttract, type Attract, type AttractState } from './attract';

export interface Settings {
  difficulty: Difficulty;
  quarterLen: number;
  teamName: string;
  /** Franchise: let the coach rotate your team (default) or sub yourself. */
  autoSubs?: boolean;
  /** On defense, jump to the defender on the ball after every catch (default) or only switch yourself. */
  autoSwitch?: boolean;
}

export function controlsHtml(): string {
  return `
    <div class="controls">
      <h3>Controls</h3>
      <table>
        <tr><th>Move</th><td><kbd>WASD</kbd> or arrow keys</td></tr>
        <tr><th>Shoot / Block</th><td><kbd>J</kbd> or <kbd>Space</kbd>. Hold, then release when the meter hits green</td></tr>
        <tr><th>Dunk</th><td>Hold <kbd>Shift</kbd> and shoot near the rim</td></tr>
        <tr><th>Pass / Switch</th><td><kbd>K</kbd>. Add <kbd>Shift</kbd> to throw an alley-oop to a teammate near the rim</td></tr>
        <tr><th>Steal</th><td><kbd>L</kbd>. Add <kbd>Shift</kbd> to shove (type matchups apply)</td></tr>
        <tr><th>Turbo</th><td><kbd>Shift</kbd></td></tr>
        <tr><th>Special move</th><td><kbd>I</kbd> or <kbd>E</kbd> when the special bar is full</td></tr>
        <tr><th>Pause</th><td><kbd>P</kbd> or <kbd>Esc</kbd></td></tr>
      </table>
      <p class="note">Gamepad: <span class="xbtn xx">X</span> shoot, <span class="xbtn xa">A</span> pass, <span class="xbtn xb">B</span> steal, <span class="xbtn xy">Y</span> special, any bumper or trigger for turbo. On phones, use the on-screen stick and buttons.</p>
    </div>`;
}

/** Difficulty and quarter-length pickers, shown on the matchup screen after the draft. */
export function settingsHtml(settings: Settings, opts: { subs?: boolean } = {}): string {
  return `
    <div class="game-settings">
      <div class="field">Difficulty
        <div class="seg" id="difficulty">
          ${(Object.keys(DIFFICULTIES) as Difficulty[]).map((d) =>
            `<button data-v="${d}" class="${d === settings.difficulty ? 'on' : ''}">${DIFFICULTIES[d].label}</button>`).join('')}
        </div>
      </div>
      <div class="field">Quarter length
        <div class="seg" id="qlen">
          ${[60, 120, 180, 300].map((s) =>
            `<button data-v="${s}" class="${s === settings.quarterLen ? 'on' : ''}">${s / 60} min</button>`).join('')}
        </div>
      </div>
      <div class="field">Defense switching
        <div class="seg" id="dswitch">
          <button data-v="auto" class="${settings.autoSwitch !== false ? 'on' : ''}">Auto</button>
          <button data-v="manual" class="${settings.autoSwitch === false ? 'on' : ''}">Manual</button>
        </div>
      </div>
      ${opts.subs ? `
      <div class="field">Substitutions
        <div class="seg" id="subs">
          <button data-v="auto" class="${settings.autoSubs !== false ? 'on' : ''}">Auto</button>
          <button data-v="manual" class="${settings.autoSubs === false ? 'on' : ''}">Manual</button>
        </div>
      </div>` : ''}
    </div>`;
}

export function bindSettings(root: HTMLElement, settings: Settings, onChange: () => void) {
  const seg = (id: string, apply: (v: string) => void) => {
    const el = root.querySelector<HTMLElement>(id);
    if (!el) return;
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b) return;
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      apply(b.dataset.v!);
      onChange();
    });
  };
  seg('#difficulty', (v) => (settings.difficulty = v as Difficulty));
  seg('#qlen', (v) => (settings.quarterLen = Number(v)));
  seg('#subs', (v) => (settings.autoSubs = v === 'auto'));
  seg('#dswitch', (v) => (settings.autoSwitch = v === 'auto'));
}

export interface TitleOptions {
  /** One-line summary of the saved franchise, or null when there is none. */
  saved: string | null;
  /** One-line summary of a league draft in progress, or null. */
  draft: string | null;
  /** One-line summary of the saved "My Drafted Team", or null when there is none. */
  drafted: string | null;
  onContinue: () => void;
  onResumeDraft: () => void;
  /** Erases every save and setting this game keeps in the browser. */
  onDeleteData: () => void;
  /** Starts a franchise with the chosen team source. */
  onNew: (source: TeamSource) => void;
  onQuick: () => void;
  onSeason: () => void;
  /** Before a Season Draft: resolves to what to run after leaving the menu, or null to stay put. */
  confirmSeason?: () => Promise<(() => void) | null>;
  onRoster: () => void;
}

const TIPS = [
  'Hold shoot, release on green: a perfect release never misses',
  'Shift + shoot near the rim to dunk',
  'Cover all five positions in your starting five for a +2 lineup bonus',
  'Type matchups apply when you shove: Fighting beats Rock, Water beats Fire',
  'Fill the special bar, then hit I or E for your Pokémon\'s signature move',
  'Draft a backup at every position: starters tire and the bench steps in',
];
const TEASERS = [
  '<b>NEW</b> Season Draft: draft ten, sim a full season, share your team',
  'Franchise: 9-week seasons, badges, level-ups and evolutions',
  'Quick Play: draft five, pick a gym leader, tip off',
];
// Sponsor slots for the ticker: swap in a real sponsor here.
const ADS = ['Your ad here'];

/** Bottom ticker: live score, tips and mode teasers. A static single line when motion is off. */
function tickerHtml(isStatic: boolean): string {
  if (isStatic) return `<div class="ticker static" aria-label="Game modes"><span class="tk-item">Season Draft</span><span class="tk-item">Franchise</span><span class="tk-item">Quick Play</span></div>`;
  const item = (cls: string, html: string) => `<span class="tk-item ${cls}">${html}</span>`;
  const run = [
    item('tk-live-item', '<b class="tk-tag">LIVE</b><span class="tk-live">warming up…</span>'),
    item('', `<b class="tk-tag">TIP</b>${TIPS[0]}`),
    item('', TEASERS[0]),
    item('', `<b class="tk-tag">TIP</b>${TIPS[1]}`),
    item('', TEASERS[1]),
    item('', `<b class="tk-tag">TIP</b>${TIPS[2]}`),
    item('', TEASERS[2]),
    item('', `<b class="tk-tag">TIP</b>${TIPS[3]}`),
    item('', `<b class="tk-tag">TIP</b>${TIPS[4]}`),
    item('', `<b class="tk-tag">TIP</b>${TIPS[5]}`),
    item('tk-ad', `<b class="tk-tag">AD</b>${ADS[0]}`),
  ].join('');
  // Two copies, so the loop has no seam; the second is hidden from screen readers.
  return `<div class="ticker" role="marquee" aria-label="Live score, tips and game modes"><div class="tk-track"><div class="tk-run">${run}</div><div class="tk-run" aria-hidden="true">${run}</div></div></div>`;
}

/** Title screen: a silent CPU game behind the menu, Season Draft as the big call to action, then the other modes. */
export function menuScreen(root: HTMLElement, settings: Settings, onChange: () => void, opts: TitleOptions) {
  const isStatic = prefersStatic();
  const parade = [...POKEMON].sort(() => Math.random() - 0.5).slice(0, 14);
  let attract: Attract | null = null;
  const destroy = () => {
    attract?.stop();
    attract = null;
  };
  /** Every way out of the menu shuts the attract game down first. */
  const leave = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
    destroy();
    fn(...a);
  };
  let source: TeamSource = 'draft';

  root.innerHTML = `
    <div class="menu">
      <div class="attract" aria-hidden="true">
        ${isStatic
          ? `<div class="attract-static"><div class="parade">${parade.map((m, i) => `<img src="${spriteUrl(m.dex)}" alt="" style="--i:${i}">`).join('')}</div></div>`
          : '<canvas class="attract-canvas"></canvas>'}
        <div class="attract-dim"></div>
      </div>
      <div class="menu-in">
        <header class="title">
          <h1 class="logo"><span class="logo-poke">POKé</span><span class="logo-jam">JAM</span></h1>
          <p class="tag">Draft your Pokémon. Run the floor. Full-court 5-on-5 arcade hoops.</p>
        </header>
        <div class="play-row">
          <label class="field team-field" for="team-name">Your team
            <input id="team-name" maxlength="20" autocomplete="off" value="${esc(lettersName(settings.teamName))}">
          </label>
          <button class="btn play-btn" data-go="season" aria-label="Season Draft: draft 10, sim a season, get your grade">DRAFT &amp; GET GRADED<small>Draft 10 · sim a season · get your grade</small></button>
        </div>
        ${opts.drafted ? `<p class="mode-saved hero-saved"><span class="lbl">My drafted team</span> ${esc(opts.drafted)}</p>` : ''}
        <div class="mode-grid">
          <section class="mode-card quick">
            <h2>Quick Play</h2>
            <p class="setup-note">Pick any Gym Leader or the Elite Four, draft five Pokémon against them and play on any court. Pure arcade.</p>
            <div class="actions"><button class="btn big" data-go="quick">Quick Play</button></div>
          </section>
          <section class="mode-card franchise">
            <h2>Franchise</h2>
          ${opts.draft ? `
            <div class="continue">
              <span class="lbl">Draft in progress</span>
              <strong>${esc(opts.draft)}</strong>
              <button class="btn primary big" data-go="resume-draft">Continue draft</button>
            </div>` : ''}
          ${opts.saved ? `
            <div class="continue">
              <span class="lbl">Your franchise</span>
              <strong>${esc(opts.saved)}</strong>
              <button class="btn ${opts.draft ? '' : 'primary big'}" data-go="continue">Continue franchise</button>
            </div>` : ''}
            <p class="setup-note">Draft ten Pokémon against the eight Kanto Gym Leaders and the Elite Four, then play a 9-week season and the playoffs. Starters tire and the bench steps in. Earn badges, level up and evolve, season after season.</p>
            <div class="field">Start with
              <div class="seg" id="source">
                <button data-v="draft" class="on">Draft</button>
                <button data-v="mine" ${opts.drafted ? '' : 'disabled title="Finish a Season Draft first"'}>My Drafted Team</button>
                <button data-v="random">Random</button>
              </div>
            </div>
            <div class="actions">
              <button class="btn" data-go="new">${opts.saved || opts.draft ? 'New franchise' : 'Start a franchise'}</button>
            </div>
          </section>
          <section class="mode-card roster-mode">
            <h2>Roster</h2>
            <p class="setup-note">Scout all ${POKEMON.length} Pokémon before you draft: every rating, position, size and evolution.</p>
            <div class="actions"><button class="btn" data-go="roster">Browse the full roster</button></div>
          </section>
        </div>
        <details class="controls-fold">
          <summary>Controls</summary>
          ${controlsHtml()}
        </details>
        <footer class="foot">
          <p>Fan-made game. Pokémon and its characters are trademarks of Nintendo, Game Freak and The Pokémon Company. Sprites from PokeAPI.</p>
          <p class="foot-links">
            <a href="privacy.html">Privacy</a>
            <a href="terms.html">Terms</a>
            <a href="contact.html">Contact</a>
            <button class="link-btn" data-go="delete">Delete saved data</button>
          </p>
          <p class="foot-status" role="status"></p>
        </footer>
      </div>
      ${tickerHtml(isStatic)}
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);

  // ---- attract game ----
  const canvas = $<HTMLCanvasElement>('.attract-canvas');
  if (canvas) {
    // The game plays silently behind the menu; its score only feeds the bottom ticker.
    const live = root.querySelectorAll<HTMLElement>('.tk-live');
    const show = (s: AttractState) => {
      const line = `${s.home} ${s.score[0]} - ${s.score[1]} ${s.away} · ${s.clock}`;
      live.forEach((el) => (el.textContent = line));
    };
    attract = startAttract(canvas, show);
  }

  const name = $<HTMLInputElement>('#team-name')!;
  name.addEventListener('input', () => {
    settings.teamName = lettersName(name.value);
    onChange();
  });
  const startNew = $<HTMLButtonElement>('[data-go="new"]')!;
  let armed = !opts.saved && !opts.draft;
  const tryNew = () => {
    if (armed) return leave(opts.onNew)(source);
    // Starting over erases the saved franchise, so ask for a second tap.
    armed = true;
    startNew.textContent = opts.saved ? 'Tap again to replace your franchise' : 'Tap again to restart the draft';
    startNew.classList.add('warn');
  };
  const sourceSeg = $('#source')!;
  sourceSeg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b || b.disabled) return;
    source = b.dataset.v as TeamSource;
    sourceSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  });
  const quick = leave(opts.onQuick);
  $('[data-go="quick"]')!.addEventListener('click', quick);
  $('[data-go="season"]')!.addEventListener('click', async () => {
    const go = opts.confirmSeason ? await opts.confirmSeason() : opts.onSeason;
    if (go) leave(go)();
  });
  $('[data-go="roster"]')!.addEventListener('click', leave(opts.onRoster));
  startNew.addEventListener('click', tryNew);
  $('[data-go="continue"]')?.addEventListener('click', leave(opts.onContinue));
  $('[data-go="resume-draft"]')?.addEventListener('click', leave(opts.onResumeDraft));
  const del = $<HTMLButtonElement>('[data-go="delete"]')!;
  let delArmed = false;
  del.addEventListener('click', () => {
    if (!delArmed) {
      delArmed = true;
      del.textContent = 'Tap again to erase your franchise, draft and settings';
      del.classList.add('warn');
      return;
    }
    leave(opts.onDeleteData)();
  });
}
