// Pack Battles: two players split the cost of a pack, snake-draft five each, play one Quick Play game,
// and the winner gets the pack. Money, eligibility and the result all live on the server
// (see battles/service.ts); these screens only show what it says.
import { courtFor } from '../data/courts';
import { TYPE_COLORS, type Mon } from '../data/pokemon';
import { USER_STYLE, contrastAway } from '../franchise/league';
import type { Audio } from '../game/audio';
import { teamOvr } from '../game/game';
import type { TeamDef } from '../game/types';
import {
  BATTLE_QUARTERS, PACK_TIERS, RESTRICTED_REGIONS, TIER_ORDER, US_REGIONS, battles, entryOf, money, regionName,
  type Battle, type Challenger, type PackTier, type WonPack,
} from '../battles/service';
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
    const bal = battles.balance();
    const blocked = battles.blocked();
    const unclaimed = prizes.filter((p) => !p.claimed).length;

    const body = tab === 'open' ? openHtml(open, bal, !!blocked) : tab === 'mine' ? mineHtml(mine) : prizesHtml(prizes);
    root.innerHTML = `
      <div class="quick battles">
        <header class="draft-head">
          <button class="btn ghost small" data-a="menu">Menu</button>
          <div class="status"><span class="round">PACK BATTLES</span><span class="otc">Split the pack. Win it all.</span></div>
          <button class="btn primary small" data-a="create" ${blocked ? 'disabled' : ''}>Create battle</button>
        </header>
        <section class="wallet">
          <div><span class="lbl">Balance</span><strong>${money(bal)}</strong></div>
          <button class="btn small" data-a="funds" ${blocked ? 'disabled' : ''}>Add funds</button>
          <button class="link-btn" data-a="elig">${battles.eligibility() ? `Playing from ${esc(regionName(battles.eligibility()!.region))}` : 'Confirm age and state'}</button>
        </section>
        ${blocked ? `<p class="gate-note" role="status">${esc(blocked)} You can still look around.</p>` : ''}
        <section class="prize-pool">
          <div class="pool-head"><span class="eyebrow">How it works</span><span class="split-chip">Split entry</span></div>
          <ul class="pool-list">
            ${TIER_ORDER.map((t) => `
              <li style="--tc:${PACK_TIERS[t].color}">
                ${packSvg(t, 40)}
                <span><b>${PACK_TIERS[t].label}</b><small>${money(entryOf(t))} each · ${money(PACK_TIERS[t].price)} pull</small></span>
              </li>`).join('')}
          </ul>
        </section>
        <div class="seg tabs" role="tablist">
          ${([['open', 'Open battles', open.length], ['mine', 'Your battles', mine.filter((b) => b.status === 'open' || b.status === 'ready').length], ['prizes', 'Prizes', unclaimed]] as const)
            .map(([id, label, count]) => `<button role="tab" aria-selected="${tab === id}" class="${tab === id ? 'on' : ''}" data-tab="${id}">${label}${count ? ` <em>${count}</em>` : ''}</button>`).join('')}
        </div>
        ${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ''}
        <div class="tab-body">${body}</div>
        <p class="note center">You and your challenger each pay half the price of a gacha pull. Win the game and the pot buys you one pull from that Collector Crypt machine; what you pull is random and can be worth more or less than the pot. Cancel before anyone accepts for a full refund; leaving a game in progress forfeits it. 18+ only, and not available in every state.</p>
        <p class="preview-note">Preview: play money only, and challengers are played by the CPU until online play is ready.</p>
      </div>`;

    const on = (sel: string, fn: (el: HTMLButtonElement) => void) =>
      root.querySelectorAll<HTMLButtonElement>(sel).forEach((b) => b.addEventListener('click', () => fn(b)));
    on('[data-a="menu"]', () => { stopTimer(); act.menu(); });
    on('[data-a="create"]', () => createSheet(tab));
    on('[data-a="funds"]', () => fundsSheet(tab));
    on('[data-a="elig"]', () => eligibilitySheet(tab));
    on('[data-tab]', (b) => { audio.blip(); lobby(b.dataset.tab as Tab); });
    on('[data-accept]', (b) => {
      const battle = open.find((x) => x.id === b.dataset.accept);
      if (battle) confirmSheet(battle);
    });
    on('[data-play]', (b) => {
      const battle = mine.find((x) => x.id === b.dataset.play);
      if (battle) { audio.blip(true); draft(battle); }
    });
    on('[data-cancel]', (b) => {
      const battle = mine.find((x) => x.id === b.dataset.cancel);
      battles.cancel(b.dataset.cancel!);
      lobby('mine', battle ? `Battle cancelled. ${money(entryOf(battle.tier))} refunded.` : 'Battle cancelled.');
    });
    on('[data-claim]', (b) => {
      const p = prizes.find((x) => x.id === b.dataset.claim);
      if (p) claimSheet(p);
    });

    // Watch for a challenger while one of your battles is waiting.
    const waiting = new Set(mine.filter((b) => b.status === 'open').map((b) => b.id));
    if (tab === 'mine' && waiting.size) {
      timer = window.setInterval(() => {
        if (battles.mine().some((b) => b.status === 'ready' && waiting.has(b.id))) {
          audio.blip(true);
          lobby('mine', 'A challenger accepted and paid their half. Your battle is ready!');
        }
      }, 1000);
    }

  }

  function openHtml(list: Battle[], bal: number, blocked: boolean): string {
    if (!list.length) return `<p class="empty">No open battles right now. Create one and wait for a challenger.</p>`;
    return `<ul class="battle-grid">${list.map((b) => {
      const t = PACK_TIERS[b.tier];
      const r = b.rival!;
      const cost = entryOf(b.tier);
      return `
        <li><article class="battle-card" style="--tc:${t.color}; --rc:${r.color}">
          <div class="bc-pack">${packSvg(b.tier, 58)}</div>
          <div class="bc-info">
            <span class="opp-lvl">${t.label} · ${qLabel(b.quarterLen)}</span>
            <strong>${esc(r.name)}</strong>
            <span class="bc-handle">@${esc(r.handle)} · ${ago(b.createdAt)}</span>
            <span class="types">${typeChips(r)}</span>
          </div>
          <div class="bc-go">
            <button class="btn primary" data-accept="${b.id}" ${blocked || bal < cost ? 'disabled' : ''}>Accept · ${money(cost)}</button>
            <small>Win a ${money(t.price)} pull</small>
          </div>
        </article></li>`;
    }).join('')}</ul>`;
  }

  function mineHtml(list: Battle[]): string {
    if (!list.length) return `<p class="empty">You haven't posted or played a battle yet. Accept an open one or create your own.</p>`;
    return `<ul class="my-battles">${list.map((b) => {
      const t = PACK_TIERS[b.tier];
      const r = b.rival;
      const [line, right] =
        b.status === 'open' ? [`<span class="waiting"><i class="ball-spin" aria-hidden="true"></i>Waiting for a challenger… <small>${money(entryOf(b.tier))} in escrow</small></span>`, `<button class="btn small ghost" data-cancel="${b.id}">Cancel · refund</button>`]
        : b.status === 'ready' ? [`vs <b>${esc(r!.name)}</b> <small>@${esc(r!.handle)} · pot ${money(t.price)}</small>`, `<button class="btn primary" data-play="${b.id}">Play now</button>`]
        : b.status === 'won' ? [`Beat <b>${esc(r!.name)}</b>`, `<span class="res win">W ${b.score![0]}–${b.score![1]}</span>`]
        : [`Lost to <b>${esc(r!.name)}</b>`, `<span class="res loss">${b.forfeit ? 'Forfeit' : `L ${b.score![0]}–${b.score![1]}`}</span>`];
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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const close = () => { bg.remove(); window.removeEventListener('keydown', onKey); };
    window.addEventListener('keydown', onKey);
    bg.addEventListener('click', (e) => { if (e.target === bg || (e.target as HTMLElement).closest('.close')) close(); });
    bind(bg.querySelector('.sheet')!, close);
  }

  function eligibilitySheet(from: Tab) {
    const cur = battles.eligibility();
    sheet(`
      <h3>Before you battle</h3>
      <p class="note">Pack Battles use real money, so we need two things first.</p>
      <div class="elig">
        <label class="field" for="elig-region">State you're playing from
          <select id="elig-region">
            <option value="">Choose your state</option>
            ${US_REGIONS.map(([c, n]) => `<option value="${c}" ${cur?.region === c ? 'selected' : ''}>${esc(n)}${RESTRICTED_REGIONS.includes(c) ? ' (not available)' : ''}</option>`).join('')}
          </select>
        </label>
        <label class="check"><input type="checkbox" id="elig-adult" ${cur?.adult ? 'checked' : ''}> I'm 18 or older</label>
      </div>
      <p class="note">We also check your location and age when you add funds.</p>
      <div class="actions center"><button class="btn primary big" data-a="save" disabled>Continue</button></div>`,
    (el, close) => {
      const region = el.querySelector<HTMLSelectElement>('#elig-region')!;
      const adult = el.querySelector<HTMLInputElement>('#elig-adult')!;
      const go = el.querySelector<HTMLButtonElement>('[data-a="save"]')!;
      const sync = () => (go.disabled = !region.value);
      region.addEventListener('change', sync);
      sync();
      go.addEventListener('click', () => {
        battles.setEligibility({ adult: adult.checked, region: region.value });
        close();
        lobby(from);
      });
    });
  }

  function fundsSheet(from: Tab) {
    sheet(`
      <h3>Add funds</h3>
      <p class="note">Balance ${money(battles.balance())}. Preview mode adds play money.</p>
      <div class="seg funds">${[1250, 2500, 5000].map((c) => `<button data-v="${c}">${money(c)}</button>`).join('')}</div>`,
    (el, close) => el.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((b) => b.addEventListener('click', () => {
      battles.addFunds(Number(b.dataset.v));
      audio.blip(true);
      close();
      lobby(from, `${money(Number(b.dataset.v))} added.`);
    })));
  }

  function confirmSheet(b: Battle) {
    const t = PACK_TIERS[b.tier];
    sheet(`
      <h3>Accept this battle?</h3>
      <div class="claim">${packSvg(b.tier, 72)}
        <ul class="terms">
          <li>You pay <b>${money(entryOf(b.tier))}</b>. ${esc(b.rival!.name)} already paid their half.</li>
          <li>Win the game and the ${money(t.price)} pot buys you one pull from the <b>${t.label}</b> machine.</li>
          <li>Lose, or leave the game, and the pull goes to them.</li>
          <li>Pulls are random: the card can be worth more or less than ${money(t.price)}.</li>
        </ul>
      </div>
      <p class="note">Balance after: ${money(battles.balance() - entryOf(b.tier))}</p>
      <div class="actions center"><button class="btn primary big" data-a="go">Pay ${money(entryOf(b.tier))} and draft</button></div>`,
    (el, close) => el.querySelector('[data-a="go"]')!.addEventListener('click', () => {
      close();
      try {
        const battle = battles.accept(b.id);
        audio.blip(true);
        draft(battle);
      } catch (e) {
        lobby('open', (e as Error).message);
      }
    }));
  }

  function createSheet(from: Tab) {
    let tier: PackTier = 'starter';
    let qlen = 120;
    const render = (el: HTMLElement) => {
      el.querySelector('.create-pack')!.innerHTML = packSvg(tier, 92, 'float');
      el.querySelector('.create-sum')!.textContent = `You pay ${money(entryOf(tier))} now · winner gets a ${money(PACK_TIERS[tier].price)} pull`;
    };
    sheet(`
      <h3>Create a battle</h3>
      <div class="create">
        <div class="create-pack"></div>
        <div class="create-fields">
          <div class="field">Pack
            <div class="seg" id="tier">${TIER_ORDER.map((t) =>
              `<button data-v="${t}" class="${t === tier ? 'on' : ''}">${PACK_TIERS[t].short}<small>${money(entryOf(t))} each</small></button>`).join('')}</div>
          </div>
          <div class="field">Quarter length
            <div class="seg" id="bq">${BATTLE_QUARTERS.map((s) => `<button data-v="${s}" class="${s === qlen ? 'on' : ''}">${s / 60} min</button>`).join('')}</div>
          </div>
        </div>
      </div>
      <p class="create-sum"></p>
      <p class="note">Your half sits in escrow until someone accepts. Cancel before then for a full refund.</p>
      <div class="actions center"><button class="btn primary big" data-a="post">Pay and post</button></div>`,
    (el, close) => {
      render(el);
      const seg = (id: string, set: (v: string) => void) => el.querySelector(id)!.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
        if (!b) return;
        el.querySelectorAll(`${id} button`).forEach((x) => x.classList.toggle('on', x === b));
        set(b.dataset.v!);
        audio.blip();
        render(el);
      });
      seg('#tier', (v) => (tier = v as PackTier));
      seg('#bq', (v) => (qlen = Number(v)));
      el.querySelector('[data-a="post"]')!.addEventListener('click', () => {
        close();
        try {
          battles.create(tier, qlen);
          audio.blip(true);
          lobby('mine', `Battle posted. ${money(entryOf(tier))} is in escrow until a challenger accepts.`);
        } catch (e) {
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
          <li>Connect the Solana wallet the card should go to.</li>
          <li>We buy your pull from the Collector Crypt machine and send the card there.</li>
        </ol>
      </div>
      <div class="actions center"><button class="btn primary big" data-a="claim">Request claim</button></div>`,
    (el, close) => el.querySelector('[data-a="claim"]')!.addEventListener('click', () => {
      battles.claim(p.id);
      close();
      lobby('prizes', 'Claim requested.');
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
      () => lobby('mine', 'Your battle is waiting in Your battles. Come back to play it.'), () => {});
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
            ${side(userName(), USER_STYLE.color, `You · paid ${money(entryOf(b.tier))}`, mine)}
            <div class="stake">${packSvg(b.tier, 84, 'float')}<span>Winner gets</span><b>${t.label}</b><small>${money(t.price)} pull</small></div>
            ${side(r.name, r.color, `@${r.handle} · paid ${money(entryOf(b.tier))}`, theirs)}
          </div>
          <ul class="rules">
            <li>All-Star difficulty</li><li>${qLabel(b.quarterLen)}</li><li>No stamina</li><li>Overtime until someone wins</li><li class="warn">Leaving forfeits</li>
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
    }, () => {
      battles.forfeit(b.id);
      lobby('mine', `You left the game, so ${r.name} get the ${PACK_TIERS[b.tier].label}.`);
    }, { quitLabel: 'Forfeit and quit' });
  }

  function outcomeHtml(b: Battle, won: boolean): string {
    const t = PACK_TIERS[b.tier];
    const who = won ? userName() : b.rival!.name;
    return won
      ? `<section class="pack-won" style="--tc:${t.color}">
          <div class="pack-rip">${packSvg(b.tier, 116)}<i class="burst" aria-hidden="true"></i></div>
          <p>${esc(who.toUpperCase())} won the ${t.short} PACK!</p>
          <p class="pw-2">Your ${money(t.price)} pull is in your prizes. Claim it and we open it from the Collector Crypt machine and send you the card.</p>
        </section>`
      : `<section class="pack-won lost" style="--tc:${t.color}">
          <div class="pack-gone">${packSvg(b.tier, 84)}</div>
          <p>${esc(who.toUpperCase())} took the ${t.short} PACK.</p>
          <p class="pw-2">Your ${money(entryOf(b.tier))} went into the winner's pull.</p>
        </section>`;
  }

  lobby();
  // First visit: ask for age and state before anything else.
  if (!battles.eligibility()) eligibilitySheet('open');
}
