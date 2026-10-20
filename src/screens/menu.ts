import { POKEMON, spriteUrl } from '../data/pokemon';
import { DIFFICULTIES, type Difficulty } from '../game/types';
import { esc } from '../util';

export interface Settings {
  difficulty: Difficulty;
  quarterLen: number;
  teamName: string;
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
      <p class="note">Gamepad: A shoot, X pass, B steal, Y special, any bumper or trigger for turbo. On phones, use the on-screen stick and buttons.</p>
    </div>`;
}

/** Difficulty and quarter-length pickers, shown on the matchup screen after the draft. */
export function settingsHtml(settings: Settings): string {
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
    </div>`;
}

export function bindSettings(root: HTMLElement, settings: Settings, onChange: () => void) {
  const seg = (id: string, apply: (v: string) => void) => {
    const el = root.querySelector<HTMLElement>(id)!;
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
}

export interface TitleOptions {
  /** One-line summary of the saved franchise, or null when there is none. */
  saved: string | null;
  onContinue: () => void;
  onNew: () => void;
}

/** Title screen: continue the saved franchise, or name a team and start a new one with the draft. */
export function menuScreen(root: HTMLElement, settings: Settings, onChange: () => void, opts: TitleOptions) {
  const parade = [...POKEMON].sort(() => Math.random() - 0.5).slice(0, 14);
  root.innerHTML = `
    <div class="menu">
      <div class="parade" aria-hidden="true">
        ${parade.map((m, i) => `<img src="${spriteUrl(m.dex)}" alt="" style="--i:${i}">`).join('')}
      </div>
      <header class="title">
        <h1 class="logo"><span class="logo-poke">POKé</span><span class="logo-jam">JAM</span></h1>
        <p class="tag">Draft five Pokémon. Run the floor. Full-court 5-on-5 arcade hoops.</p>
      </header>
      <div class="menu-grid">
        <section class="card setup">
          ${opts.saved ? `
            <div class="continue">
              <span class="lbl">Your franchise</span>
              <strong>${esc(opts.saved)}</strong>
              <button class="btn primary big" data-go="continue">Continue franchise</button>
            </div>` : ''}
          <label class="field" for="team-name">${opts.saved ? 'Or start over with a new team' : 'Name your team'}
            <input id="team-name" maxlength="20" autocomplete="off" value="${esc(settings.teamName)}">
          </label>
          <p class="setup-note">Start a franchise: draft five Pokémon against five rival teams, then play a 10-week season and the playoffs. Your Pokémon level up, evolve and carry over to the next season.</p>
          <div class="actions">
            <button class="btn ${opts.saved ? '' : 'primary big'}" data-go="new">${opts.saved ? 'New franchise' : 'Draft your team'}</button>
          </div>
        </section>
        <section class="card">${controlsHtml()}</section>
      </div>
      <footer class="foot">Fan-made game. Pokémon and its characters are trademarks of Nintendo, Game Freak and The Pokémon Company. Sprites from PokeAPI.</footer>
    </div>`;

  const name = root.querySelector<HTMLInputElement>('#team-name')!;
  name.addEventListener('input', () => {
    settings.teamName = name.value;
    onChange();
  });
  const startNew = root.querySelector<HTMLButtonElement>('[data-go="new"]')!;
  let armed = !opts.saved;
  const tryNew = () => {
    if (armed) return opts.onNew();
    // Starting over erases the saved franchise, so ask for a second tap.
    armed = true;
    startNew.textContent = 'Tap again to replace your franchise';
    startNew.classList.add('warn');
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryNew(); });
  startNew.addEventListener('click', tryNew);
  root.querySelector('[data-go="continue"]')?.addEventListener('click', opts.onContinue);
}
