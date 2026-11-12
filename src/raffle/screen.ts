// Opens the weekly challenges screen. One server read when it opens, and a balance read when a wallet is linked.
import { supabase } from '../multiplayer/shared/supabase';
import { armLinkAnchor, linkInjectedWallet } from '../wallet/linkSheet';
import { getPhantomProvider } from '../wallet/phantom';
import { loadChallenges, loadHolderEntries } from './client';
import { challengesHtml, modelFromDefaults, modelFromServer, type ChallengeModel } from './challengesView';

const panel = (inner: string) => `<div class="menu"><header class="title"><h1 class="logo"><span class="logo-jam">CHALLENGES</span></h1>
  <p class="tag">A free entry in the weekly card drawing</p></header><section class="card setup">${inner}</section></div>`;

export async function openChallenges(ctx: { root: HTMLElement; back(): void }): Promise<void> {
  const { root } = ctx;
  root.className = 'screen-menu';
  window.scrollTo(0, 0);
  let model: ChallengeModel = modelFromDefaults();
  let userId = '';
  const draw = (m: ChallengeModel, error?: string | null) => {
    model = m;
    root.innerHTML = panel(challengesHtml(m, error));
    root.querySelector('[data-a="back"]')?.addEventListener('click', ctx.back);
    const link = root.querySelector<HTMLAnchorElement>('[data-a="link-wallet"]');
    if (link && userId) link.addEventListener('click', (e) => {
      const provider = getPhantomProvider();
      if (provider) {
        e.preventDefault();
        void linkInjectedWallet(userId).then(() => openChallenges(ctx)).catch((err: unknown) => {
          if (!root.isConnected) return;
          draw(model, err instanceof Error ? err.message : 'Could not link the wallet.');
        });
        return;
      }
      armLinkAnchor(link, userId);
    });
  };
  draw(modelFromDefaults());
  try {
    const me = await loadChallenges(true);
    if (!root.isConnected) return;
    if (!me) { draw(modelFromDefaults()); return; }
    try {
      const { data } = await supabase().auth.getSession();
      const user = data.session?.user;
      userId = user && !user.is_anonymous ? user.id : '';
    } catch { userId = ''; }
    const next = modelFromServer(me);
    draw(next);
    if (!me.wallet) return;
    const held = await loadHolderEntries();
    if (!root.isConnected) return;
    draw({ ...next, holderNow: held?.holder ?? null, holderError: !held, wallet: held?.wallet ?? next.wallet });
  } catch (e) {
    if (!root.isConnected) return;
    draw(modelFromDefaults(), (e as Error).message);
  }
}
