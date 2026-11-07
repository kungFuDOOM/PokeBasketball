// 3-Point Contest side mode: pick shooter -> pick money rack -> play 60s -> results. Offline, solo.
// Scaffold only. Implementation order and acceptance checks: /workspace/pj-3pt-ref/TASKS.md
import type { Audio } from '../game/audio';
import type { Settings } from './menu';

export interface ThreePtActions {
  menu(): void;
}

export type ThreePtStep = 'pick' | 'rack' | 'play' | 'results';

export function threePtContest(root: HTMLElement, settings: Settings, audio: Audio, act: ThreePtActions): void {
  void settings; void audio;
  let step: ThreePtStep = 'pick';
  // TODO(tasks 5-9): picker, money-rack UI, play loop, results. Each step renders into `root`.
  const render = () => {
    root.innerHTML = `<div class="threept threept-${step}">
      <h1>3-Point Contest</h1>
      <p class="setup-note">Coming soon.</p>
      <button class="btn" data-go="menu">Menu</button>
    </div>`;
    root.querySelector('[data-go="menu"]')!.addEventListener('click', () => act.menu());
  };
  render();
}
