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

/** Title screen: name your team, then the only way in is the draft. */
export function menuScreen(root: HTMLElement, settings: Settings, onChange: () => void, onDraft: () => void) {
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
          <label class="field" for="team-name">Name your team
            <input id="team-name" maxlength="20" autocomplete="off" value="${esc(settings.teamName)}">
          </label>
          <p class="setup-note">Snake-draft five Pokémon against Team Rocket's front office, then take your squad onto the court.</p>
          <div class="actions">
            <button class="btn primary big" data-go="draft">Draft your team</button>
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
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') onDraft(); });
  root.querySelector('[data-go="draft"]')!.addEventListener('click', onDraft);
}
