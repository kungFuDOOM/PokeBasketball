// Opens the weekly challenges screen. One server read when it opens. The online client loads with this chunk.
import { loadChallenges } from './client';
import { challengesHtml, modelFromDefaults, modelFromServer } from './challengesView';

const panel = (inner: string) => `<div class="menu"><header class="title"><h1 class="logo"><span class="logo-jam">CHALLENGES</span></h1>
  <p class="tag">A free entry in the weekly card drawing</p></header><section class="card setup">${inner}</section></div>`;

export async function openChallenges(ctx: { root: HTMLElement; back(): void }): Promise<void> {
  const { root } = ctx;
  root.className = 'screen-menu';
  window.scrollTo(0, 0);
  const draw = (inner: string) => {
    root.innerHTML = panel(inner);
    root.querySelector('[data-a="back"]')?.addEventListener('click', ctx.back);
  };
  draw(challengesHtml(modelFromDefaults()));
  try {
    const me = await loadChallenges(true);
    if (!root.isConnected) return;
    draw(challengesHtml(me ? modelFromServer(me) : modelFromDefaults()));
  } catch (e) {
    if (!root.isConnected) return;
    draw(challengesHtml(modelFromDefaults(), (e as Error).message));
  }
}
