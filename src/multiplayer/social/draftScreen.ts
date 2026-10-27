// The Social quick draft screen (#28): both players pick from a shared pool, snake order, one Pokémon per position,
// 12 seconds a pick. The server runs the draft (pokejam_draft_state / pokejam_draft_pick); this screen shows it,
// counts down, and sends my picks. When it's done, the match comes back with the drafted rosters.
import { monByDex, spriteUrl, POSITIONS, type Pos } from '../../data/pokemon';
import { esc } from '../../util';
import { DRAFT_PICKS, GONE_AFTER, PICK_SECONDS, canPick, teamOf, type DraftView } from '../shared/draft';
import { classify } from '../shared/capacity';
import type { OnlineMatch, SupabaseMatchService } from '../shared/onlineMatchService';
import { backoffMs } from '../shared/throttle';
import type { ModeContext } from '../shared/types';

const POLL_MS = 700;
/** This many polls in a row failing (each already retried on a busy server) ends the draft with the error. */
const MAX_MISSES = 5;

export type DraftEnd = { match: OnlineMatch } | { left: 'me' | 'them' } | { failed: unknown };

export function runDraft(ctx: ModeContext, svc: SupabaseMatchService, match: OnlineMatch): Promise<DraftEnd> {
  const { root } = ctx;
  root.className = 'screen-draft-online';
  window.scrollTo(0, 0);
  root.innerHTML = `<div class="sdraft">
      <header class="sd-head">
        <div class="sd-turn" data-turn>Getting the draft ready…</div>
        <div class="sd-timer" data-timer><i></i><span></span></div>
        <button class="btn ghost small" data-a="leave">Leave</button>
      </header>
      <div class="sd-main">
        <div class="sd-pool" data-pool></div>
        <aside class="sd-teams" data-teams></aside>
      </div>
      <p class="sd-msg" data-msg hidden></p>
    </div>`;
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const started = performance.now();
  let view: DraftView | null = null;
  let gotAt = 0;
  let busy = false;
  let misses = 0;
  let over = false;
  let timer = 0;
  let raf = 0;

  return new Promise<DraftEnd>((resolve) => {
    const end = (e: DraftEnd) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      resolve(e);
    };
    const say = (t: string) => { const m = q('[data-msg]'); m.hidden = false; m.textContent = t; setTimeout(() => (m.hidden = true), 2500); };

    const render = () => {
      const v = view;
      if (!v) return;
      const mineTurn = v.on_turn === v.me && !v.done;
      const turn = q('[data-turn]');
      turn.textContent = v.done ? 'Draft done: tip-off!' : mineTurn ? `Your pick (${v.turn + 1} of ${DRAFT_PICKS})` : `${match.opponent.name} is picking…`;
      turn.classList.toggle('mine', mineTurn);
      const taken = new Map(v.picks.map((p) => [p.dex, p.side]));
      q('[data-pool]').innerHTML = POSITIONS.map((pos) => `<div class="sd-col"><h4>${pos}</h4>${v.pool.filter((m) => m.pos === pos).map(({ dex }) => {
        const mon = monByDex(dex);
        const by = taken.get(dex);
        const cls = by === undefined ? (canPick(v, dex) ? 'ok' : 'no') : by === v.me ? 'mine' : 'theirs';
        return `<button class="sd-card ${cls}" data-dex="${dex}" ${cls === 'ok' ? '' : 'disabled'} aria-label="${esc(mon.name)}, ${pos}, ${mon.ovr} overall">
          <img src="${spriteUrl(dex)}" alt=""><span>${esc(mon.name)}</span><b>${mon.ovr}</b></button>`;
      }).join('')}</div>`).join('');
      const team = (side: 0 | 1, title: string) => {
        const t = teamOf(v, side);
        return `<div class="sd-team ${side === v.me ? 'me' : 'them'}"><h4>${esc(title)}</h4>${POSITIONS.map((pos: Pos) => {
          const dex = t[pos];
          return `<div class="sd-slot"><b>${pos}</b>${dex ? `<img src="${spriteUrl(dex)}" alt=""><span>${esc(monByDex(dex).name)}</span>` : '<span class="empty">—</span>'}</div>`;
        }).join('')}</div>`;
      };
      q('[data-teams]').innerHTML = team(v.me, 'You') + team((1 - v.me) as 0 | 1, match.opponent.name);
    };

    // The countdown runs locally between server checks, from the server's own seconds left.
    const tick = () => {
      if (over) return;
      const v = view;
      const el = q('[data-timer]');
      if (v && !v.done) {
        const left = Math.max(0, v.seconds_left - (performance.now() - gotAt) / 1000);
        el.querySelector<HTMLElement>('i')!.style.width = `${Math.min(1, left / PICK_SECONDS) * 100}%`;
        el.querySelector('span')!.textContent = String(Math.ceil(left));
        el.classList.toggle('low', left < 4);
      } else if (v?.done) {
        el.querySelector<HTMLElement>('i')!.style.width = '0%';
        el.querySelector('span')!.textContent = '';
      }
      raf = requestAnimationFrame(tick);
    };

    const take = (v: DraftView) => {
      view = v;
      gotAt = performance.now();
      render();
    };

    const poll = async () => {
      if (over) return;
      try {
        const v = await svc.draftState(match.id);
        if (over) return;
        take(v);
        if (v.done) {
          setTimeout(async () => end({ match: await svc.matchInfo(match.id).catch(() => match) }), 1200);
          return;
        }
        const quiet = v.opponent_seen_ago ?? (performance.now() - started) / 1000;
        if (quiet > GONE_AFTER) {
          await svc.leave(match.id);
          end({ left: 'them' });
          return;
        }
        misses = 0;
      } catch (e) {
        // The server is struggling: back off (with jitter) instead of polling every 0.7 s, and stop after a few misses.
        if (++misses >= MAX_MISSES) {
          await svc.leave(match.id);
          end({ failed: e });
          return;
        }
        say(classify(e).message);
      }
      timer = window.setTimeout(poll, misses ? Math.max(POLL_MS, backoffMs(misses, 700, 5000)) : POLL_MS);
    };

    root.addEventListener('click', async (e) => {
      const card = (e.target as HTMLElement).closest<HTMLButtonElement>('.sd-card.ok');
      if (card && view && !busy && canPick(view, Number(card.dataset.dex))) {
        busy = true;
        root.querySelectorAll<HTMLButtonElement>('.sd-card').forEach((b) => (b.disabled = true));
        try {
          take(await svc.draftPick(match.id, Number(card.dataset.dex)));
        } catch (x) {
          const p = classify(x);
          say(p.kind !== 'busy' && /turn|picked|already have|over/i.test(p.message) ? 'Too late: that pick was taken.' : p.message);
          try { take(await svc.draftState(match.id)); } catch { /* the next poll will */ }
        }
        busy = false;
      }
      if ((e.target as HTMLElement).closest('[data-a="leave"]')) {
        await svc.leave(match.id);
        end({ left: 'me' });
      }
    });

    raf = requestAnimationFrame(tick);
    void poll();
  });
}
