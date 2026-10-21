// Pack Battles lobby: sign in with a wallet, fund your balance, post or accept a battle, and see your
// prizes. Online (HttpBackend) battles go to the live room in screens/online.ts; the offline preview
// (LocalBackend) plays a CPU challenger with the normal draft and game.

import { courtFor } from '../data/courts';
import { TYPE_COLORS, type Mon } from '../data/pokemon';
import { USER_STYLE, contrastAway } from '../franchise/league';
import type { Audio } from '../game/audio';
import { teamOvr } from '../game/game';
import type { TeamDef } from '../game/types';
import { ApiError, type Backend } from '../battles/backend';
import { LocalBackend, type Rival } from '../battles/local';
import { BATTLE_QUARTERS, PACK_TIERS, TIER_ORDER, US_REGIONS, regionName, type PackTier } from '../battles/service';
import { HttpBackend } from '../net/http';
import { MICRO, usd, type BattleView, type Me, type PrizeView, type PublicConfig } from '../net/protocol';
import { detectWallets, openInWalletLinks, solanaPayLink } from '../net/wallet';
import { packSvg } from '../ui/pack';
import { abbr, esc, shuffle } from '../util';
import { draftScreen } from './draft';
import type { Settings } from './menu';
import { onlineMatch } from './online';
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
const short = (w: string) => (w.length > 12 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);
const oddsLine = (t: PackTier) => Object.entries(PACK_TIERS[t].odds).map(([k, v]) => `${Math.round(v * 100)}% ${k}`).join(' · ');
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

export function battleScreen(root: HTMLElement, backend: Backend, settings: Settings, audio: Audio, act: BattleActions) {
  const online = backend instanceof HttpBackend ? backend : null;
  const local = backend instanceof LocalBackend ? backend : null;
  let timer = 0;
  let cfg: PublicConfig | null = null;
  let me: Me | null = null;
  let askedEligibility = false;
  const stopTimer = () => window.clearInterval(timer);
  const entry = (t: PackTier) => cfg?.tiers.find((x) => x.tier === t)?.entry ?? (PACK_TIERS[t].price * (MICRO / 100)) / 2;
  const price = (t: PackTier) => entry(t) * 2;
  const name = () => me?.teamName ?? (settings.teamName.trim() || 'Pallet Town');
  const user = () => ({ name: name(), abbr: abbr(name()), ...USER_STYLE, human: true });

  // ------------------------------------------------------------ lobby

  async function lobby(tab: Tab = 'open', flash = '') {
    stopTimer();
    root.className = 'screen-quick';
    try {
      cfg ??= await backend.config();
      me = await backend.me();
    } catch (e) {
      return offline(errText(e));
    }
    const titleName = settings.teamName.trim() || 'Pallet Town';
    if (local && me && me.teamName !== titleName) me = await local.setTeamName(titleName);
    let open: BattleView[] = [];
    let mine: BattleView[] = [];
    let prizes: PrizeView[] = [];
    try {
      [open, mine, prizes] = await Promise.all([backend.open(), me ? backend.mine() : [], me ? backend.prizes() : []]);
    } catch (e) {
      flash ||= errText(e);
    }
    const blocked = me?.blocked ?? (me ? null : 'Connect a wallet to play.');
    const active = mine.filter((b) => ['open', 'ready', 'drafting', 'playing'].includes(b.state));
    const fresh = prizes.filter((p) => p.state !== 'sent').length;
    const body = tab === 'open' ? openHtml(open, !!blocked) : tab === 'mine' ? mineHtml(mine) : prizesHtml(prizes);

    root.innerHTML = `
      <div class="quick battles">
        <header class="draft-head">
          <button class="btn ghost small" data-a="menu">Menu</button>
          <div class="status"><span class="round">PACK BATTLES</span><span class="otc">Split the pack. Win it all.</span></div>
          <button class="btn primary small" data-a="create" ${blocked ? 'disabled' : ''}>Create battle</button>
        </header>
        ${accountHtml()}
        ${me?.blocked ? `<p class="gate-note" role="status">${esc(me.blocked)} ${me.eligibility ? '' : '<button class="link-btn" data-a="elig">Do it now</button>'}</p>` : ''}
        <section class="prize-pool">
          <div class="pool-head"><span class="eyebrow">How it works</span><span class="split-chip">Split entry</span></div>
          <ul class="pool-list">
            ${TIER_ORDER.map((t) => `
              <li style="--tc:${PACK_TIERS[t].color}">
                ${packSvg(t, 40)}
                <span><b>${PACK_TIERS[t].label}</b><small>${usd(entry(t))} each · ${usd(price(t))} pull</small></span>
              </li>`).join('')}
          </ul>
        </section>
        <div class="seg tabs" role="tablist">
          ${([['open', 'Open battles', open.length], ['mine', 'Your battles', active.length], ['prizes', 'Prizes', fresh]] as const)
            .map(([id, label, n]) => `<button role="tab" aria-selected="${tab === id}" class="${tab === id ? 'on' : ''}" data-tab="${id}">${label}${n ? ` <em>${n}</em>` : ''}</button>`).join('')}
        </div>
        ${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ''}
        <div class="tab-body">${body}</div>
        <p class="note center">You and your challenger each pay half the price of a Collector Crypt gacha pull. Win the game and the pot buys you one pull from that machine; what you pull is random and can be worth more or less than the pot. Cancel before anyone accepts for a full refund; leaving a game in progress forfeits it. 18+ only.</p>
        ${local ? '<p class="preview-note">Preview: play money only, and challengers are played by the CPU. Point the game at a Pack Battles server to play for real.</p>' : ''}
      </div>`;

    const on = (sel: string, fn: (el: HTMLButtonElement) => void) =>
      root.querySelectorAll<HTMLButtonElement>(sel).forEach((b) => b.addEventListener('click', () => fn(b)));
    on('[data-a="menu"]', () => { stopTimer(); act.menu(); });
    on('[data-a="create"]', () => createSheet(tab));
    on('[data-a="elig"]', () => eligibilitySheet(tab));
    on('[data-a="funds"]', () => (online ? depositSheet(tab) : playMoneySheet(tab)));
    on('[data-a="withdraw"]', () => withdrawSheet(tab));
    on('[data-a="team"]', () => teamSheet(tab));
    on('[data-a="signout"]', () => void online?.signOut().then(() => lobby(tab)));
    on('[data-wallet]', (b) => void signIn(Number(b.dataset.wallet), tab));
    on('[data-tab]', (b) => { audio.blip(); void lobby(b.dataset.tab as Tab); });
    on('[data-accept]', (b) => { const x = open.find((o) => o.id === b.dataset.accept); if (x) confirmSheet(x); });
    on('[data-play]', (b) => { const x = mine.find((o) => o.id === b.dataset.play); if (x) { audio.blip(true); play(x); } });
    on('[data-cancel]', (b) => {
      const x = mine.find((o) => o.id === b.dataset.cancel);
      backend.cancel(b.dataset.cancel!)
        .then(() => lobby('mine', x ? `Battle cancelled. ${usd(entry(x.tier))} refunded.` : 'Battle cancelled.'))
        .catch((e) => lobby('mine', errText(e)));
    });

    // First time in: ask for age and state before anything else.
    if (me && !me.eligibility && !askedEligibility) {
      askedEligibility = true;
      eligibilitySheet(tab);
    }

    // While a battle of yours is waiting for a challenger (or a prize is on its way), check back often.
    const waiting = new Set(mine.filter((b) => b.state === 'open').map((b) => b.id));
    if ((tab === 'mine' && waiting.size) || (tab === 'prizes' && fresh)) {
      timer = window.setInterval(async () => {
        try {
          if (tab === 'mine' && (await backend.mine()).some((b) => b.state === 'ready' && waiting.has(b.id))) {
            audio.blip(true);
            void lobby('mine', 'A challenger accepted and paid their half. Your battle is ready!');
          } else if (tab === 'prizes' && (await backend.prizes()).filter((p) => p.state !== 'sent').length < fresh) {
            void lobby('prizes', 'Your pull was sent.');
          }
        } catch { /* try again next tick */ }
      }, 3000);
    }
  }

  function offline(why: string) {
    root.innerHTML = `
      <div class="quick battles">
        <header class="draft-head"><button class="btn ghost small" data-a="menu">Menu</button>
          <div class="status"><span class="round">PACK BATTLES</span><span class="otc">Can't reach the server</span></div></header>
        <p class="gate-note">${esc(why)}</p>
        <div class="actions center"><button class="btn primary" data-a="retry">Try again</button></div>
      </div>`;
    root.querySelector('[data-a="menu"]')!.addEventListener('click', act.menu);
    root.querySelector('[data-a="retry"]')!.addEventListener('click', () => void lobby());
  }

  function accountHtml(): string {
    if (online && !me) {
      const wallets = detectWallets();
      return `
        <section class="wallet connect">
          <div class="connect-copy"><span class="lbl">Wallet</span><strong>Connect a Solana wallet to play</strong>
            <small>Your wallet is your account: it signs you in (free, no transaction) and receives the pulls you win.</small></div>
          <div class="connect-btns">
            ${wallets.length ? wallets.map((w, i) => `<button class="btn primary" data-wallet="${i}">${esc(w.name)}</button>`).join('')
              : `<span class="note">No wallet found in this browser.</span>${openInWalletLinks().map((l) => `<a class="btn" href="${esc(l.href)}">Open in ${esc(l.name)}</a>`).join('')}`}
          </div>
        </section>`;
    }
    if (!me) return '';
    return `
      <section class="wallet">
        <div><span class="lbl">Balance</span><strong>${usd(me.balance)}</strong></div>
        <button class="btn small" data-a="funds">${online ? 'Deposit' : 'Add play money'}</button>
        ${online ? '<button class="btn small ghost" data-a="withdraw">Withdraw</button>' : ''}
        <span class="acct">
          ${online ? `<span class="addr" title="${esc(me.wallet)}">${esc(short(me.wallet))}</span>` : ''}
          ${online ? `<button class="link-btn" data-a="team">${esc(me.teamName)}</button>` : ''}
          <button class="link-btn" data-a="elig">${me.eligibility ? esc(regionName(me.eligibility.region)) : 'Confirm age and state'}</button>
          ${online ? '<button class="link-btn" data-a="signout">Sign out</button>' : ''}
        </span>
      </section>`;
  }

  async function signIn(i: number, tab: Tab) {
    const w = detectWallets()[i];
    if (!w || !online) return;
    try {
      me = await online.signIn(w);
      // Carry the team name from the title screen over the first time.
      const titleName = settings.teamName.trim();
      if (me.teamName === 'Pallet Town' && titleName && titleName !== me.teamName) me = await online.setTeamName(titleName);
      await lobby(tab, 'Signed in.');
    } catch (e) {
      void lobby(tab, errText(e));
    }
  }

  function openHtml(list: BattleView[], blocked: boolean): string {
    if (!list.length) return `<p class="empty">No open battles right now. Create one and wait for a challenger.</p>`;
    return `<ul class="battle-grid">${list.map((b) => {
      const t = PACK_TIERS[b.tier];
      const rival = local?.rivalIn(b);
      return `
        <li><article class="battle-card" style="--tc:${t.color}; --rc:${rival?.color ?? '#9aa0c8'}">
          <div class="bc-pack">${packSvg(b.tier, 58)}</div>
          <div class="bc-info">
            <span class="opp-lvl">${t.label} · ${qLabel(b.quarterLen)}</span>
            <strong>${esc(b.host.teamName)}</strong>
            <span class="bc-handle">@${esc(short(b.host.wallet))} · ${ago(b.createdAt)}</span>
            ${rival ? `<span class="types">${rival.types.map((ty) => `<i style="--tc:${TYPE_COLORS[ty]}">${ty}</i>`).join('')}</span>` : ''}
          </div>
          <div class="bc-go">
            <button class="btn primary" data-accept="${b.id}" ${blocked || (me?.balance ?? 0) < entry(b.tier) ? 'disabled' : ''}>Accept · ${usd(entry(b.tier))}</button>
            <small>Win a ${usd(price(b.tier))} pull</small>
          </div>
        </article></li>`;
    }).join('')}</ul>`;
  }

  function mineHtml(list: BattleView[]): string {
    if (!me) return `<p class="empty">Connect a wallet to see your battles.</p>`;
    if (!list.length) return `<p class="empty">You haven't posted or played a battle yet. Accept an open one or create your own.</p>`;
    return `<ul class="my-battles">${list.map((b) => {
      const t = PACK_TIERS[b.tier];
      const other = b.side === 0 ? b.guest : b.host;
      const won = b.winner !== null && b.winner === b.side;
      const score = b.score && b.side !== null ? `${b.score[b.side]}–${b.score[1 - b.side]}` : '';
      const [line, right] =
        b.state === 'open' ? [`<span class="waiting"><i class="ball-spin" aria-hidden="true"></i>Waiting for a challenger… <small>${usd(entry(b.tier))} in escrow</small></span>`, `<button class="btn small ghost" data-cancel="${b.id}">Cancel · refund</button>`]
        : ['ready', 'drafting', 'playing'].includes(b.state) ? [`vs <b>${esc(other?.teamName ?? '')}</b> <small>pot ${usd(price(b.tier))}</small>`, `<button class="btn primary" data-play="${b.id}">${b.state === 'ready' ? 'Play now' : 'Rejoin'}</button>`]
        : b.state === 'done' ? [`${won ? 'Beat' : 'Lost to'} <b>${esc(other?.teamName ?? '')}</b>`, `<span class="res ${won ? 'win' : 'loss'}">${b.forfeit ? (won ? 'W · forfeit' : 'Forfeit') : `${won ? 'W' : 'L'} ${score}`}</span>`]
        : [`vs <b>${esc(other?.teamName ?? '')}</b>`, `<span class="res">${b.state === 'void' ? 'Refunded' : 'Cancelled'}</span>`];
      return `
        <li class="mb-${b.state === 'done' ? (won ? 'won' : 'lost') : b.state}" style="--tc:${t.color}">
          ${packSvg(b.tier, 34)}
          <span class="mb-main"><span class="mb-tier">${t.label} · ${qLabel(b.quarterLen)}</span><span class="mb-line">${line}</span></span>
          ${right}
        </li>`;
    }).join('')}</ul>`;
  }

  function prizesHtml(list: PrizeView[]): string {
    if (!me) return `<p class="empty">Connect a wallet to see your prizes.</p>`;
    if (!list.length) return `<p class="empty">No pulls yet. Win a battle and it lands here.</p>`;
    const status = (p: PrizeView) =>
      local ? 'Preview prize: in a real battle this is sent to your wallet.'
      : p.state === 'sent' ? (p.mode === 'open' ? `Opened: <b>${esc(p.rarity ?? 'card')}</b>, sent to your wallet.` : 'Unopened pack sent to your wallet. Rip it on Collector Crypt.')
      : p.state === 'failed' ? "Delayed. We're on it; nothing to do on your side."
      : 'Buying your pull…';
    return `<ul class="prize-grid">${list.map((p) => `
      <li style="--tc:${PACK_TIERS[p.tier].color}">
        ${packSvg(p.tier, 76, p.state === 'sent' ? '' : 'float')}
        <strong>${PACK_TIERS[p.tier].label}</strong>
        <small>${status(p)}</small>
        ${p.memo ? `<small class="memo" title="Collector Crypt memo">${esc(p.memo)}</small>` : ''}
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
    const cur = me?.eligibility;
    const off = cfg?.restrictedRegions ?? [];
    sheet(`
      <h3>Before you battle</h3>
      <p class="note">Pack Battles use real money, so we need two things first.</p>
      <div class="elig">
        <label class="field" for="elig-region">State you're playing from
          <select id="elig-region">
            <option value="">Choose your state</option>
            ${US_REGIONS.map(([c, n]) => `<option value="${c}" ${cur?.region === c ? 'selected' : ''}>${esc(n)}${off.includes(c) ? ' (not available)' : ''}</option>`).join('')}
          </select>
        </label>
        <label class="check"><input type="checkbox" id="elig-adult" ${cur?.adult ? 'checked' : ''}> I'm 18 or older</label>
      </div>
      <div class="actions center"><button class="btn primary big" data-a="save" disabled>Continue</button></div>`,
    (el, close) => {
      const region = el.querySelector<HTMLSelectElement>('#elig-region')!;
      const adult = el.querySelector<HTMLInputElement>('#elig-adult')!;
      const go = el.querySelector<HTMLButtonElement>('[data-a="save"]')!;
      const sync = () => (go.disabled = !region.value);
      region.addEventListener('change', sync);
      sync();
      go.addEventListener('click', () => {
        go.disabled = true;
        backend.setEligibility(adult.checked, region.value)
          .then((m) => { me = m; close(); return lobby(from); })
          .catch((e) => { close(); return lobby(from, errText(e)); });
      });
    });
  }

  function teamSheet(from: Tab) {
    sheet(`
      <h3>Team name</h3>
      <label class="field" for="team-in">Shown to your challengers<input id="team-in" maxlength="20" value="${esc(name())}"></label>
      <div class="actions center"><button class="btn primary big" data-a="save">Save</button></div>`,
    (el, close) => el.querySelector('[data-a="save"]')!.addEventListener('click', () => {
      backend.setTeamName(el.querySelector<HTMLInputElement>('#team-in')!.value)
        .then((m) => { me = m; close(); return lobby(from); })
        .catch((e) => { close(); return lobby(from, errText(e)); });
    }));
  }

  function playMoneySheet(from: Tab) {
    sheet(`
      <h3>Add play money</h3>
      <p class="note">Preview mode: this is pretend money for trying battles out.</p>
      <div class="seg funds">${[12.5, 25, 50].map((d) => `<button data-v="${d * MICRO}">${usd(d * MICRO)}</button>`).join('')}</div>`,
    (el, close) => el.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((b) => b.addEventListener('click', () => {
      local?.addFunds(Number(b.dataset.v));
      audio.blip(true);
      close();
      void lobby(from, `${usd(Number(b.dataset.v))} added.`);
    })));
  }

  function depositSheet(from: Tab) {
    if (!online || !cfg || !me) return;
    const c = cfg;
    const api = online;
    const start = me.balance;
    let amount = 25;
    sheet(`
      <h3>Deposit USDC</h3>
      <p class="note">Send USDC on Solana <b>from the wallet you signed in with</b> (${esc(short(me.wallet))}). It's credited automatically once the network confirms it, usually within a minute.</p>
      <div class="seg funds" id="dep-amt">${[12.5, 25, 50, 100].map((d) => `<button data-v="${d}" class="${d === amount ? 'on' : ''}">${usd(d * MICRO)}</button>`).join('')}</div>
      <div class="actions center"><a class="btn primary big" data-a="pay" href="#">Open in wallet</a></div>
      <div class="dep-addr">
        <span class="lbl">Or send manually to</span>
        <code>${esc(c.houseWallet)}</code>
        <button class="btn small" data-a="copy">Copy address</button>
        <small>USDC only, on ${c.cluster === 'devnet' ? 'Solana devnet' : 'Solana'}. Minimum ${usd(c.minDeposit)}. Transfers from an exchange or another wallet can't be matched to you automatically.</small>
      </div>
      <p class="note center" data-k="status"></p>
      <div class="actions center"><button class="btn" data-a="check">I've sent it</button></div>`,
    (el, close) => {
      const pay = el.querySelector<HTMLAnchorElement>('[data-a="pay"]')!;
      const status = el.querySelector<HTMLElement>('[data-k="status"]')!;
      const setLink = () => (pay.href = solanaPayLink(c.houseWallet, c.usdcMint, amount, 'Poké Jam'));
      setLink();
      el.querySelector('#dep-amt')!.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
        if (!b) return;
        amount = Number(b.dataset.v);
        el.querySelectorAll('#dep-amt button').forEach((x) => x.classList.toggle('on', x === b));
        setLink();
      });
      el.querySelector('[data-a="copy"]')!.addEventListener('click', () => {
        void navigator.clipboard?.writeText(c.houseWallet).then(() => (status.textContent = 'Address copied.'));
      });
      let polls = 0;
      let poll = 0;
      el.querySelector('[data-a="check"]')!.addEventListener('click', () => {
        status.textContent = 'Watching for your deposit…';
        window.clearInterval(poll);
        poll = window.setInterval(() => {
          api.scanDeposits().then((m) => {
            if (m.balance > start) {
              window.clearInterval(poll);
              close();
              void lobby(from, `Deposit received: ${usd(m.balance - start)} added.`);
            } else if (++polls > 40) {
              window.clearInterval(poll);
              status.textContent = "Not seen yet. It'll still be credited when it confirms; check back in a few minutes.";
            }
          }).catch((e) => (status.textContent = errText(e)));
        }, 5000);
      });
    });
  }

  function withdrawSheet(from: Tab) {
    if (!online || !me) return;
    const api = online;
    sheet(`
      <h3>Withdraw</h3>
      <p class="note">Balance ${usd(me.balance)}. Withdrawals are reviewed and sent as USDC, usually within a day.</p>
      <label class="field" for="wd-amt">Amount (USD)<input id="wd-amt" type="number" min="1" step="0.01" value="${(me.balance / MICRO).toFixed(2)}"></label>
      <label class="field" for="wd-to">To wallet<input id="wd-to" value="${esc(me.wallet)}"></label>
      <div class="actions center"><button class="btn primary big" data-a="go">Request withdrawal</button></div>`,
    (el, close) => el.querySelector('[data-a="go"]')!.addEventListener('click', () => {
      const amt = Math.round(Number(el.querySelector<HTMLInputElement>('#wd-amt')!.value) * MICRO);
      const to = el.querySelector<HTMLInputElement>('#wd-to')!.value.trim();
      api.withdraw(amt, to)
        .then((m) => { me = m; close(); return lobby(from, `Withdrawal of ${usd(amt)} requested.`); })
        .catch((e) => { close(); return lobby(from, errText(e)); });
    }));
  }

  function confirmSheet(b: BattleView) {
    const t = PACK_TIERS[b.tier];
    sheet(`
      <h3>Accept this battle?</h3>
      <div class="claim">${packSvg(b.tier, 72)}
        <ul class="terms">
          <li>You pay <b>${usd(entry(b.tier))}</b>. ${esc(b.host.teamName)} already paid their half.</li>
          <li>Win the game and the ${usd(price(b.tier))} pot buys you one pull from the <b>${t.label}</b> machine.</li>
          <li>Lose, or leave the game, and the pull goes to them.</li>
          <li>Pulls are random: the card can be worth more or less than ${usd(price(b.tier))}.</li>
        </ul>
      </div>
      <p class="odds">${esc(t.ccName)} odds: ${oddsLine(b.tier)}</p>
      <p class="note">Balance after: ${usd((me?.balance ?? 0) - entry(b.tier))}</p>
      <div class="actions center"><button class="btn primary big" data-a="go">Pay ${usd(entry(b.tier))} and draft</button></div>`,
    (el, close) => el.querySelector('[data-a="go"]')!.addEventListener('click', () => {
      close();
      backend.accept(b.id)
        .then((battle) => { audio.blip(true); play(battle); })
        .catch((e) => lobby('open', e instanceof ApiError ? e.message : errText(e)));
    }));
  }

  function createSheet(from: Tab) {
    let tier: PackTier = 'pokemon_25';
    let qlen = 120;
    const render = (el: HTMLElement) => {
      el.querySelector('.create-pack')!.innerHTML = packSvg(tier, 92, 'float');
      el.querySelector('.create-sum')!.textContent = `You pay ${usd(entry(tier))} now · winner gets a ${usd(price(tier))} pull`;
      el.querySelector('.create-odds')!.textContent = `${PACK_TIERS[tier].ccName} odds: ${oddsLine(tier)}`;
    };
    sheet(`
      <h3>Create a battle</h3>
      <div class="create">
        <div class="create-pack"></div>
        <div class="create-fields">
          <div class="field">Pack
            <div class="seg" id="tier">${TIER_ORDER.map((t) =>
              `<button data-v="${t}" class="${t === tier ? 'on' : ''}">${PACK_TIERS[t].short}<small>${usd(entry(t))} each</small></button>`).join('')}</div>
          </div>
          <div class="field">Quarter length
            <div class="seg" id="bq">${BATTLE_QUARTERS.map((s) => `<button data-v="${s}" class="${s === qlen ? 'on' : ''}">${s / 60} min</button>`).join('')}</div>
          </div>
        </div>
      </div>
      <p class="create-sum"></p>
      <p class="odds create-odds"></p>
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
        backend.create(tier, qlen)
          .then(() => { audio.blip(true); return lobby('mine', `Battle posted. ${usd(entry(tier))} is in escrow until a challenger accepts.`); })
          .catch((e) => lobby(from, errText(e)));
      });
    });
  }

  // ------------------------------------------------------------ playing a battle

  function play(b: BattleView) {
    stopTimer();
    if (online) {
      onlineMatch(root, online, b, audio, {
        lobby: (flash) => void lobby('mine', flash ?? ''),
        prizes: () => void lobby('prizes'),
        menu: act.menu,
      });
    } else if (local) previewBattle(local, b);
  }

  /** Preview: the normal draft and game against the CPU challenger. */
  function previewBattle(lb: LocalBackend, b: BattleView) {
    const r = lb.rivalIn(b);
    root.className = 'screen-draft';
    window.scrollTo(0, 0);
    draftScreen(root, { teams: [user(), { name: r.teamName, abbr: r.abbr, color: r.color, color2: r.color2, human: false, leader: r.wallet, types: r.types }], order: shuffle([0, 1]), taken: [], rounds: 5 }, audio,
      (rosters) => matchup(lb, b, r, rosters[0], rosters[1]),
      () => void lobby('mine', 'Your battle is waiting in Your battles.'), () => {});
  }

  function matchup(lb: LocalBackend, b: BattleView, r: Rival, mine: Mon[], theirs: Mon[]) {
    const t = PACK_TIERS[b.tier];
    root.className = 'screen-quick';
    window.scrollTo(0, 0);
    const side = (n: string, color: string, sub: string, mons: Mon[]) => `
      <div class="nx-team" style="--tc:${color}"><span class="where">${esc(sub)}</span><h3>${esc(n)}</h3><p>${teamOvr(mons)} OVR</p>${lineupHtml(mons)}</div>`;
    root.innerHTML = `
      <div class="quick">
        <section class="card next battle-next" style="--tc:${t.color}">
          <p class="eyebrow">Pack Battle · Preview</p>
          <div class="nx-cols">
            ${side(name(), USER_STYLE.color, `You · paid ${usd(entry(b.tier))}`, mine)}
            <div class="stake">${packSvg(b.tier, 84, 'float')}<span>Winner gets</span><b>${t.label}</b><small>${usd(price(b.tier))} pull</small></div>
            ${side(r.teamName, r.color, `@${r.wallet} · paid ${usd(entry(b.tier))}`, theirs)}
          </div>
          <ul class="rules"><li>All-Star difficulty</li><li>${qLabel(b.quarterLen)}</li><li>No stamina</li><li>Overtime until someone wins</li><li class="warn">Leaving forfeits</li></ul>
          <div class="actions center"><button class="btn primary big" data-a="tip">Tip off</button><button class="btn ghost" data-a="back">Back to battles</button></div>
        </section>
      </div>`;
    root.querySelector('[data-a="tip"]')!.addEventListener('click', () => {
      root.className = 'screen-game';
      audio.unlock();
      const home: TeamDef = { ...user(), roster: mine };
      const away = contrastAway(home, { name: r.teamName, abbr: r.abbr, color: r.color, color2: r.color2, roster: theirs, human: false, coach: r.wallet });
      playGame(root, { home, away, quarterLen: b.quarterLen, difficulty: 'allstar', court: courtFor(away), autoSwitch: settings.autoSwitch !== false }, audio, (g) => {
        const won = g.score[0] > g.score[1];
        lb.finish(b.id, [g.score[0], g.score[1]]);
        root.className = 'screen-results';
        window.scrollTo(0, 0);
        resultsScreen(root, g, {
          tag: `Pack Battle · ${t.label}`,
          headline: won ? 'You win the pack!' : `${r.teamName} take the pack`,
          extraHtml: won
            ? `<section class="pack-won" style="--tc:${t.color}"><div class="pack-rip">${packSvg(b.tier, 116)}<i class="burst" aria-hidden="true"></i></div><p>YOU WON THE ${t.short} PACK!</p><p class="pw-2">In a real battle, your ${esc(t.ccName)} goes straight to your wallet.</p></section>`
            : `<section class="pack-won lost" style="--tc:${t.color}"><div class="pack-gone">${packSvg(b.tier, 84)}</div><p>${esc(r.teamName.toUpperCase())} TOOK THE ${t.short} PACK.</p><p class="pw-2">Your ${usd(entry(b.tier))} went into the winner's pull.</p></section>`,
          buttons: won
            ? [{ id: 'prizes', label: 'See your prizes', kind: 'primary' }, { id: 'lobby', label: 'Back to battles' }]
            : [{ id: 'lobby', label: 'Find another battle', kind: 'primary' }, { id: 'menu', label: 'Main menu', kind: 'ghost' }],
          onAction: (a) => (a === 'menu' ? act.menu() : void lobby(a === 'prizes' ? 'prizes' : 'open')),
        });
      }, () => {
        lb.finish(b.id, [0, 1], true);
        void lobby('mine', `You left the game, so ${r.teamName} get the pull.`);
      }, { quitLabel: 'Forfeit and quit' });
    });
    root.querySelector('[data-a="back"]')!.addEventListener('click', () => void lobby('mine'));
  }

  void lobby();
}
