// Multiplayer hub: lists only the modes whose build flag is on. Each mode loads via dynamic import,
// so a disabled mode's code is left out of the bundle.
import { MODE_PACK_BATTLES, MODE_RANKED, MODE_SOCIAL } from '../config/features';
import type { ModeContext } from './shared/types';

type OpenMode = (ctx: ModeContext) => void | Promise<void>;
interface ModeCard { id: string; title: string; note: string; load(): Promise<OpenMode> }

const MODES: ModeCard[] = [];
if (MODE_SOCIAL) MODES.push({ id: 'social', title: 'Social', note: 'Casual and unranked. Quick match online or play a friend with a room code.',
  load: async () => (await import('./social/index')).openSocial });
if (MODE_RANKED) MODES.push({ id: 'ranked', title: 'Ranked', note: '5 placement matches, then climb from Bronze to Zenith.',
  load: async () => (await import('./ranked/index')).openRanked });
if (MODE_PACK_BATTLES) MODES.push({ id: 'pack', title: 'Pack Battles', note: 'Coming soon.',
  load: async () => (await import('./packBattles/index')).openPackBattles });

/** Modes that aren't in this build show as locked "Coming soon" tiles: no button handler, no import, no navigation. */
const LOCKED: { title: string; note: string }[] = [];
if (!MODE_RANKED) LOCKED.push({ title: 'Ranked', note: 'Placement matches and tiers.' });
if (!MODE_PACK_BATTLES) LOCKED.push({ title: 'Pack Battles', note: 'Preset, evenly matched teams. Pure skill.' });

// Each mode's chunk is requested once, as soon as the hub opens, so the first tap rarely waits on the network.
const loaded = new Map<string, Promise<OpenMode>>();
function preload(m: ModeCard): Promise<OpenMode> {
  let p = loaded.get(m.id);
  if (!p) {
    p = m.load();
    p.catch(() => loaded.delete(m.id));
    loaded.set(m.id, p);
  }
  return p;
}

/** `autoOpen`: a mode id to open straight away (coming back from a Google sign-in lands on Ranked, not the hub). */
export function multiplayerHub(ctx: Omit<ModeContext, 'back'>, onExit: () => void, autoOpen?: string) {
  const { root } = ctx;
  const show = () => {
    root.className = 'screen-menu';
    window.scrollTo(0, 0);
    root.innerHTML = `
      <div class="menu hub">
        <header class="title">
          <h1 class="logo"><span class="logo-poke">ONLINE</span><span class="logo-jam">JAM</span></h1>
          <p class="tag">Play other trainers online.</p>
        </header>
        <div class="menu-grid hub-grid">
          ${MODES.map((m) => `<section class="card setup"><div class="mode"><h2>${m.title}</h2>
            <p class="setup-note">${m.note}</p>
            <div class="actions"><button class="btn primary big" data-m="${m.id}">Play ${m.title}</button></div></div></section>`).join('')}
          ${LOCKED.map((m) => `<section class="card setup locked" aria-disabled="true"><div class="mode"><h2>${m.title}</h2>
            <p class="setup-note">${m.note}</p>
            <div class="actions"><button class="btn big" type="button" disabled aria-disabled="true">Coming soon</button></div></div></section>`).join('')}
        </div>
        <div class="actions center hub-back"><button class="btn ghost" data-go="back">Back to title</button></div>
      </div>`;
    root.querySelector('[data-go="back"]')!.addEventListener('click', onExit);
    for (const m of MODES) {
      const btn = root.querySelector<HTMLButtonElement>(`[data-m="${m.id}"]`)!;
      const label = btn.textContent;
      // Bound before the chunk arrives: a tap during the load shows a loading state, then opens the mode.
      let busy = false;
      btn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        btn.textContent = 'Loading…';
        btn.setAttribute('aria-busy', 'true');
        try {
          const open = await preload(m);
          await open({ ...ctx, back: show });
        } catch {
          btn.textContent = 'Could not load. Tap to retry';
        }
        btn.removeAttribute('aria-busy');
        if (btn.textContent === 'Loading…') btn.textContent = label;
        busy = false;
      });
      void preload(m).catch(() => {});
    }
  };
  show();
  if (autoOpen) root.querySelector<HTMLButtonElement>(`[data-m="${autoOpen}"]`)?.click();
}
