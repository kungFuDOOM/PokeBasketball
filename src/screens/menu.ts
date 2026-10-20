import { POKEMON, spriteUrl } from '../data/pokemon';
import { DIFFICULTIES, type Difficulty } from '../game/types';
import { esc } from '../util';

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
  onContinue: () => void;
  onResumeDraft: () => void;
  /** Erases every save and setting this game keeps in the browser. */
  onDeleteData: () => void;
  onNew: () => void;
  onQuick: () => void;
}

/** Title screen: name your team, then Quick Play or Franchise (continue, resume a draft, or start over). */
export function menuScreen(root: HTMLElement, settings: Settings, onChange: () => void, opts: TitleOptions) {
  const parade = [...POKEMON].sort(() => Math.random() - 0.5).slice(0, 14);
  root.innerHTML = `
    <div class="menu">
      <div class="parade" aria-hidden="true">
        ${parade.map((m, i) => `<img src="${spriteUrl(m.dex)}" alt="" style="--i:${i}">`).join('')}
      </div>
      <header class="title">
        <h1 class="logo"><span class="logo-poke">POKé</span><span class="logo-jam">JAM</span></h1>
        <p class="tag">Draft your Pokémon. Run the floor. Full-court 5-on-5 arcade hoops.</p>
      </header>
      <div class="menu-grid">
        <section class="card setup">
          <label class="field" for="team-name">Your team
            <input id="team-name" maxlength="20" autocomplete="off" value="${esc(settings.teamName)}">
          </label>
          <div class="mode">
            <h2>Quick Play</h2>
            <p class="setup-note">Pick any Gym Leader or the Elite Four, draft five Pokémon against them and play on any court. Pure arcade.</p>
            <div class="actions"><button class="btn primary big" data-go="quick">Quick Play</button></div>
          </div>
          <div class="mode">
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
            <div class="actions">
              <button class="btn" data-go="new">${opts.saved || opts.draft ? 'New franchise' : 'Start a franchise'}</button>
            </div>
          </div>
        </section>
        <section class="card">${controlsHtml()}</section>
      </div>
      <footer class="foot">
        <p>Fan-made game. Pokémon and its characters are trademarks of Nintendo, Game Freak and The Pokémon Company. Sprites from PokeAPI.</p>
        <p class="foot-links">
          <a href="privacy.html">Privacy and terms</a>
          <button class="link-btn" data-go="delete">Delete saved data</button>
        </p>
        <p class="foot-status" role="status"></p>
      </footer>
    </div>`;

  const name = root.querySelector<HTMLInputElement>('#team-name')!;
  name.addEventListener('input', () => {
    settings.teamName = name.value;
    onChange();
  });
  const startNew = root.querySelector<HTMLButtonElement>('[data-go="new"]')!;
  let armed = !opts.saved && !opts.draft;
  const tryNew = () => {
    if (armed) return opts.onNew();
    // Starting over erases the saved franchise, so ask for a second tap.
    armed = true;
    startNew.textContent = opts.saved ? 'Tap again to replace your franchise' : 'Tap again to restart the draft';
    startNew.classList.add('warn');
  };
  root.querySelector('[data-go="quick"]')!.addEventListener('click', opts.onQuick);
  startNew.addEventListener('click', tryNew);
  root.querySelector('[data-go="continue"]')?.addEventListener('click', opts.onContinue);
  root.querySelector('[data-go="resume-draft"]')?.addEventListener('click', opts.onResumeDraft);
  const del = root.querySelector<HTMLButtonElement>('[data-go="delete"]')!;
  let delArmed = false;
  del.addEventListener('click', () => {
    if (!delArmed) {
      delArmed = true;
      del.textContent = 'Tap again to erase your franchise, draft and settings';
      del.classList.add('warn');
      return;
    }
    opts.onDeleteData();
  });
}
