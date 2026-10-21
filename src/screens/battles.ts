// Pack Battles: accept or post a battle, snake-draft five against your challenger, play one
// Quick Play game, and the winner takes the prize pack. Free entry; packs come from the house pool.
// Every rule that decides a winner lives on the server (see battles/service.ts).
import { courtFor } from '../data/courts';
import { TYPE_COLORS, type Mon } from '../data/pokemon';
import { USER_STYLE, contrastAway } from '../franchise/league';
import type { Audio } from '../game/audio';
import { teamOvr } from '../game/game';
import type { TeamDef } from '../game/types';
import { BATTLE_QUARTERS, PACK_TIERS, TIER_ORDER, battles, type Battle, type Challenger, type PackTier, type WonPack } from '../battles/service';
import { packSvg } from '../ui/pack';
import { abbr, esc, shuffle } from '../util';
import { draftScreen } from './draft';
import type { Settings } from './menu';
import { playGame } from './play';
import { lineupHtml } from './quick';
import { resultsScreen } from './results';

export interface BattleActions {
  menu(): void;
}

type Tab = 'open' | 'mine' | 'prizes';

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} hr ago`;
};
const qLabel = (s: number) => `${s / 60}-min quarters`;
const typeChips = (r: Challenger) => r.types.map((t) => `<i style="--tc:${TYPE_COLORS[t]}">${t}</i>`).join('');

export function battleScreen(root: HTMLElement, settings: Settings, audio: Audio, act: BattleActions) {
  const userName = () => settings.teamName.trim() || 'Pallet Town';
  const user = () => ({ name: userName(), abbr: abbr(userName()), ...USER_STYLE, human: true });
  let timer = 0;
  const stopTimer = () => window.clearInterval(timer);

  // ------------------------------------------------------------ lobby

  function lobby(tab: Tab = 'open', flash = '') {
    stopTimer();
    root.className = 'screen-quick';
    const open = battles.open();
    const mine = battles.mine();
    const prizes = battles.prizes();
    const stock = battles.stock();
    const unclaimed = prizes.filter((p) => !p.claimed).length;

    const body = tab === 'open' ? openHtml(open) : tab === 'mine' ? mineHtml(mine) : prizesHtml(prizes);
    root.innerHTML = `
      <div class="quick battles">
        <header class="draft-head">
          <button class="btn ghost small" data-a="menu">Menu</button>
          <div class="status"><span class="round">PACK BATTLES</span><span class="otc">Win the game. Take the pack.</span></div>
          <button class="btn primary small" data-a="create">Create battle</button>
        </header>
        <section class="prize-pool">
          <div class="pool-head"><span class="eyebrow">Prize pool</span><span class="free-chip">Free entry</span></div>
          <ul class="pool-list">
            ${TIER_ORDER.map((t) => `
              <li class="${stock[t] ? '' : 'out'}" style="--tc:${PACK_TIERS[t].color}">
                ${packSvg(t, 40)}
                <span><b>${PACK_TIERS[t].label}</b><small>${stock[t] ? `${stock[t]} left` : 'All won'}</small></span>
              </li>`).join('')}
          </ul>
        </section>
        <div class="seg tabs" role="tablist">
          ${([['open', 'Open battles', open.length], ['mine', 'Your battles', mine.filter((b) => b.status === 'open' || b.status === 'ready').length], ['prizes', 'Prizes', unclaimed]] as const)
            .map(([id, label, count]) => `<button role="tab" aria-selected="${tab === id}" class="${tab === id ? 'on' : ''}" data-tab="${id}">${label}${count ? ` <em>${count}</em>` : ''}</button>`).join('')}
        </div>
        ${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ''}
        <div class="tab-body">${body}</div>
        <p class="note center">Free to enter: every pack comes from the Poké Jam prize pool, never from the players. One game, winner takes the pack. You must be 18 or older to claim a prize.</p>
        <p class="preview-note">Preview: challengers are played by the CPU until online play is ready.</p>
      </div>`;

    root.querySelector('[data-a="menu"]')!.addEventListener('click', () => { stopTimer(); act.menu(); });
    root.querySelector('[data-a="create"]')!.addEventListener('click', () => createSheet(tab));
    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      audio.blip();
      lobby(b.dataset.tab as Tab);
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach((b) => b.addEventListener('click', () => {
      try {
        const battle = battles.accept(b.dataset.accept!);
        audio.blip(true);
        draft(battle);
      } catch (e) {
        lobby('open', (e as Error).message);
      }
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((b) => b.addEventListener('click', () => {
      const battle = mine.find((x) => x.id === b.dataset.play);
      if (battle) { audio.blip(true); draft(battle); }
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach((b) => b.addEventListener('click', () => {
      battles.cancel(b.dataset.cancel!);
      lobby('mine', 'Battle cancelled.');
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-claim]').forEach((b) => b.addEventListener('click', () => {
      const p = prizes.find((x) => x.id === b.dataset.claim);
      if (p) claimSheet(p);
    }));

    // Watch for a challenger while one of your battles is waiting.
    const waiting = new Set(mine.filter((b) => b.status === 'open').map((b) => b.id));
    if (tab === 'mine' && waiting.size) {
      timer = window.setInterval(() => {
        if (battles.mine().some((b) => b.status === 'ready' && waiting.has(b.id))) {
          audio.blip(true);
          lobby('mine', 'A challenger accepted your battle!');
        }
      }, 1000);
    }
  }

  function openHtml(list: Battle[]): string {
    if (!list.length) return `<p class="empty">No open battles right now. Create one and wait for a challenger.</p>`;
    return `<ul class="battle-grid">${list.map((b) => {
      const t = PACK_TIERS[b.tier];
      const r = b.rival!;
      return `
        <li><article class="battle-card" style="--tc:${t.color}; --rc:${r.color}">
          <div class="bc-pack">${packSvg(b.tier, 58)}</div>
          <div class="bc-info">
            <span class="opp-lvl">${t.label} · ${qLabel(b.quarterLen)}</span>
            <strong>${esc(r.name)}</strong>
            <span class="bc-handle">@${esc(r.handle)} · ${ago(b.createdAt)}</span>
            <span class="types">${typeChips(r)}</span>
          </div>
          <button class="btn primary" data-accept="${b.id}">Accept</button>
        </article></li>`;
    }).join('')}</ul>`;
  }

  function mineHtml(list: Battle[]): string {
    if (!list.length) return `<p class="empty">You haven't posted or played a battle yet. Accept an open one or create your own.</p>`;
    return `<ul class="my-battles">${list.map((b) => {
      const t = PACK_TIERS[b.tier];
      const r = b.rival;
      const [line, right] =
        b.status === 'open' ? ['<span class="waiting"><i class="ball-spin" aria-hidden="true"></i>Waiting for a challenger…</span>', `<button class="btn small ghost" data-cancel="${b.id}">Cancel</button>`]
        : b.status === 'ready' ? [`vs <b>${esc(r!.name)}</b> <small>@${esc(r!.handle)}</small>`, `<button class="btn primary" data-play="${b.id}">Play now</button>`]
        : b.status === 'won' ? [`Beat <b>${esc(r!.name)}</b>`, `<span class="res win">W ${b.score![0]}–${b.score![1]}</span>`]
        : [`Lost to <b>${esc(r!.name)}</b>`, `<span class="res loss">L ${b.score![0]}–${b.score![1]}</span>`];
      return `
        <li class="mb-${b.status}" style="--tc:${t.color}">
          ${packSvg(b.tier, 34)}
          <span class="mb-main"><span class="mb-tier">${t.label} · ${qLabel(b.quarterLen)}</span><span class="mb-line">${line}</span></span>
          ${right}
        </li>`;
    }).join('')}</ul>`;
  }

  function prizesHtml(list: WonPack[]): string {
    if (!list.length) return `<p class="empty">No packs yet. Win a battle and it lands here.</p>`;
    return `<ul class="prize-grid">${list.map((p) => `
      <li style="--tc:${PACK_TIERS[p.tier].color}">
        ${packSvg(p.tier, 76, p.claimed ? '' : 'float')}
        <strong>${PACK_TIERS[p.tier].label}</strong>
        <small>Beat ${esc(p.rival)} ${p.score[0]}–${p.score[1]}</small>
        ${p.claimed ? '<span class="claimed">Claim requested</span>' : `<button class="btn primary small" data-claim="${p.id}">Claim</button>`}
      </li>`).join('')}</ul>`;
  }

  // ------------------------------------------------------------ sheets

  function sheet(html: string, bind: (el: HTMLElement, close: () => void) => void) {
    const bg = document.createElement('div');
    bg.className = 'sheet-bg';
    bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}<button class="close" aria-label="Close">×</button></div>`;
    document.body.appendChild(bg);
    const close = () => { bg.remove(); window.removeEventListener('keydown', esc_); };
    const esc_ = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', esc_);
    bg.addEventListener('click', (e) => { if (e.target === bg || (e.target as HTMLElement).closest('.close')) close(); });
    bind(bg.querySelector('.sheet')!, close);
  }

  function createSheet(from: Tab) {
    const stock = battles.stock();
    let tier: PackTier = TIER_ORDER.find((t) => stock[t] > 0) ?? 'starter';
    let qlen = 120;
    const render = (el: HTMLElement) => {
      el.querySelector('.create-pack')!.innerHTML = packSvg(tier, 92, 'float');
      el.querySelector('.create-sum')!.textContent = `${PACK_TIERS[tier].label} · ${qLabel(qlen)} · All-Star`;
    };
    sheet(`
      <h3>Create a battle</h3>
      <div class="create">
        <div class="create-pack"></div>
        <div class="create-fields">
          <div class="field">Prize pack
            <div class="seg" id="tier">${TIER_ORDER.map((t) =>
              `<button data-v="${t}" class="${t === tier ? 'on' : ''}" ${stock[t] ? '' : 'disabled'}>${PACK_TIERS[t].short}<small>${stock[t] ? `${stock[t]} left` : 'gone'}</small></button>`).join('')}</div>
          </div>
          <div class="field">Quarter length
            <div class="seg" id="bq">${BATTLE_QUARTERS.map((s) => `<button data-v="${s}" class="${s === qlen ? 'on' : ''}">${s / 60} min</button>`).join('')}</div>
          </div>
        </div>
      </div>
      <p class="create-sum"></p>
      <p class="note">Free to enter. The first player to accept plays you for this pack.</p>
      <div class="actions center"><button class="btn primary big" data-a="post">Post battle</button></div>`,
    (el, close) => {
      render(el);
      const seg = (id: string, set: (v: string) => void) => el.querySelector(id)!.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
        if (!b || b.disabled) return;
        el.querySelectorAll(`${id} button`).forEach((x) => x.classList.toggle('on', x === b));
        set(b.dataset.v!);
        audio.blip();
        render(el);
      });
      seg('#tier', (v) => (tier = v as PackTier));
      seg('#bq', (v) => (qlen = Number(v)));
      el.querySelector('[data-a="post"]')!.addEventListener('click', () => {
        try {
          battles.create(tier, qlen);
          close();
          audio.blip(true);
          lobby('mine', 'Battle posted. You\'ll see it here when a challenger accepts.');
        } catch (e) {
          close();
          lobby(from, (e as Error).message);
        }
      });
    });
  }

  function claimSheet(p: WonPack) {
    sheet(`
      <h3>Claim your ${PACK_TIERS[p.tier].label}</h3>
      <div class="claim">${packSvg(p.tier, 84, 'float')}
        <ol>
          <li>Sign in to your Poké Jam account.</li>
          <li>Confirm you're 18 or older.</li>
          <li>Add a shipping address. We mail the sealed pack.</li>
        </ol>
      </div>
      <div class="actions center"><button class="btn primary big" data-a="claim">Request claim</button></div>`,
    (el, close) => el.querySelector('[data-a="claim"]')!.addEventListener('click', () => {
      battles.claim(p.id);
      close();
      lobby('prizes', 'Claim requested. Watch your email for shipping details.');
    }));
  }

  // ------------------------------------------------------------ the battle

  const rivalTeam = (r: Challenger) => ({ name: r.name, abbr: r.abbr, color: r.color, color2: r.color2, human: false, leader: r.handle, types: r.types });

  function draft(b: Battle) {
    stopTimer();
    root.className = 'screen-draft';
    window.scrollTo(0, 0);
    draftScreen(root, { teams: [user(), rivalTeam(b.rival!)], order: shuffle([0, 1]), taken: [], rounds: 5 }, audio,
      (rosters) => matchup(b, rosters[0], rosters[1]),
      () => lobby('mine'), () => {});
  }

  function matchup(b: Battle, mine: Mon[], theirs: Mon[]) {
    const r = b.rival!;
    const t = PACK_TIERS[b.tier];
    const court = courtFor(r);
    root.className = 'screen-quick';
    window.scrollTo(0, 0);
    const side = (name: string, color: string, sub: string, mons: Mon[]) => `
      <div class="nx-team" style="--tc:${color}">
        <span class="where">${esc(sub)}</span>
        <h3>${esc(name)}</h3>
        <p>${teamOvr(mons)} OVR</p>
        ${lineupHtml(mons)}
      </div>`;
    root.innerHTML = `
      <div class="quick">
        <section class="card next battle-next" style="--tc:${t.color}">
          <p class="eyebrow">Pack Battle · ${esc(court.venue)}</p>
          <div class="nx-cols">
            ${side(userName(), USER_STYLE.color, 'You', mine)}
            <div class="stake">${packSvg(b.tier, 84, 'float')}<span>Winner takes</span><b>${t.label}</b></div>
            ${side(r.name, r.color, `@${r.handle}`, theirs)}
          </div>
          <ul class="rules">
            <li>All-Star difficulty</li><li>${qLabel(b.quarterLen)}</li><li>No stamina</li><li>Overtime until someone wins</li>
          </ul>
          <div class="actions center">
            <button class="btn primary big" data-a="tip">Tip off</button>
            <button class="btn ghost" data-a="back">Back to battles</button>
          </div>
        </section>
      </div>`;
    root.querySelector('[data-a="tip"]')!.addEventListener('click', () => play(b, mine, theirs));
    root.querySelector('[data-a="back"]')!.addEventListener('click', () => lobby('mine'));
  }

  function play(b: Battle, mine: Mon[], theirs: Mon[]) {
    const r = b.rival!;
    const court = courtFor(r);
    root.className = 'screen-game';
    audio.unlock();
    const home: TeamDef = { ...user(), roster: mine };
    const away = contrastAway(home, { name: r.name, abbr: r.abbr, color: r.color, color2: r.color2, roster: theirs, human: false, coach: r.handle });
    playGame(root, { home, away, quarterLen: b.quarterLen, difficulty: 'allstar', court, autoSwitch: settings.autoSwitch !== false }, audio, (g) => {
      const { won } = battles.finish(b.id, [g.score[0], g.score[1]]);
      root.className = 'screen-results';
      window.scrollTo(0, 0);
      resultsScreen(root, g, {
        tag: `Pack Battle · ${PACK_TIERS[b.tier].label}`,
        headline: won ? 'You win the pack!' : `${r.name} take the pack`,
        extraHtml: outcomeHtml(b, won),
        buttons: won
          ? [{ id: 'prizes', label: 'See your prizes', kind: 'primary' }, { id: 'lobby', label: 'Back to battles' }]
          : [{ id: 'lobby', label: 'Find another battle', kind: 'primary' }, { id: 'menu', label: 'Main menu', kind: 'ghost' }],
        onAction: (a) => (a === 'menu' ? act.menu() : lobby(a === 'prizes' ? 'prizes' : 'open')),
      });
    }, () => lobby('mine', 'You left the game. Your battle is still waiting in Your battles.'));
  }

  function outcomeHtml(b: Battle, won: boolean): string {
    const t = PACK_TIERS[b.tier];
    const who = won ? userName() : b.rival!.name;
    return won
      ? `<section class="pack-won" style="--tc:${t.color}">
          <div class="pack-rip">${packSvg(b.tier, 116)}<i class="burst" aria-hidden="true"></i></div>
          <p>${esc(who.toUpperCase())} won the ${t.short} PACK!</p>
          <p class="pw-2">It's in your prizes. Claim it and we ship it to you.</p>
        </section>`
      : `<section class="pack-won lost" style="--tc:${t.color}">
          <div class="pack-gone">${packSvg(b.tier, 84)}</div>
          <p>${esc(who.toUpperCase())} took the ${t.short} PACK.</p>
          <p class="pw-2">Run it back: there are more packs in the pool.</p>
        </section>`;
  }

  lobby();
}
