// Pack Battles: beat another player online to win a Collector Crypt pack. Devnet test USDC, or real USDC once the
// server's pack_real_money is on. Link a wallet by signing a message; deposit USDC from it, withdraw to it, and a card
// you keep is sent to it (migration 20261213, the pokejam-pack-wallet Edge Function).
// Enter a tier and your half of the pot (plus your half of the fee) is held from your balance. The game is the same
// online lockstep game as Ranked, with balanced teams and signed inputs. The pokejam-pack-judge Edge Function
// replays both players' inputs to decide the winner, whose pack the payout worker buys and opens; they keep the card
// or sell it back at the reveal. A player who leaves early forfeits; a tie refunds both entries. See migration 20261212.
import './pack.css';
import { connect, mobileWalletLinks, shortAddress, wallets, type Connected } from '../../ads/wallet';
import { esc } from '../../util';
import { ensureHuman, humanDeps } from '../shared/human';
import { panel } from '../shared/matchFlow';
import { playOnline, type StopReason } from '../shared/onlineGame';
import { OnlineError, SupabaseMatchService, type OnlineMatch } from '../shared/onlineMatchService';
import { ONLINE_CONFIGURED, ensureSignedIn, supabase } from '../shared/supabase';
import type { ModeContext } from '../shared/types';
import { bindChoice, cardHtml, choiceHtml, oddsBarHtml, packArt, prizeStepsHtml, revealHtml } from './art';
import { PackService, TIERS, TIER_ORDER, usd, validWallet, type BattleView, type Lobby, type PackTier, type PrizeView, type WalletMove } from './service';

const WALLET_KEY = 'pokejam.packWallet';
const PREFER_KEY = 'pokejam.packPrefer';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let service: PackService | null = null;
/** The wallet connected on this page (for signing deposits), and which network the lobby said we're on. */
let signer: Connected | null = null;
let cluster: 'devnet' | 'mainnet-beta' = 'devnet';

async function online(ctx: ModeContext): Promise<PackService> {
  const sb = supabase();
  const uid = await ensureSignedIn(sb);
  if (!service) {
    const human = (force: boolean) => ensureHuman(humanDeps(sb), force);
    service = new PackService(sb, new SupabaseMatchService(sb, uid, ['pack'], human), human,
      async () => { await sb.functions.invoke('pokejam-pack-judge', { body: {} }); },
      async (body) => {
        const { data, error } = await sb.functions.invoke('pokejam-pack-wallet', { body });
        if (!error) return data as Record<string, unknown>;
        const res = (error as { context?: unknown }).context;
        const why = res instanceof Response ? ((await res.clone().json().catch(() => null)) as { error?: string } | null)?.error : null;
        throw new OnlineError(why ?? "Couldn't reach the wallet service. Check your connection.");
      });
  }
  await service.match.setName(ctx.settings.teamName || 'Trainer');
  return service;
}

/** The server's words, in the screen's: an entry the balance can't cover names both amounts. */
function friendly(e: unknown): string {
  const msg = e instanceof OnlineError || e instanceof Error ? e.message : 'Something went wrong.';
  const short = /insufficient balance: (\d+) available, (\d+) needed/.exec(msg);
  if (short) return `Your balance is ${usd(Number(short[1]))}, and this battle costs ${usd(Number(short[2]))} to enter.`;
  if (/anonymous/i.test(msg)) return 'Online sign-in is switched off on the server right now.';
  return msg;
}

const entryCost = (t: { cost: { stake: number; fee: number } }) => Number(t.cost.stake) + Number(t.cost.fee);
const explorer = (kind: 'address' | 'tx', id: string) =>
  `https://solscan.io/${kind}/${encodeURIComponent(id)}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;

/** "25" or "12.50" dollars → USDC base units, or null. */
const micro = (dollars: string) => /^\d{1,9}(\.\d{1,6})?$/.test(dollars.trim()) ? Math.round(Number(dollars.trim()) * 1e6) : null;
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The wallets this browser has, as buttons; on a phone with none, links that open the page in a wallet app. */
function walletButtons(): string {
  const list = wallets();
  if (!list.length) {
    return `<div class="pk-nowallet"><p>No Solana wallet found in this browser.</p>
      <p class="note">On a computer, install Phantom, Solflare or Backpack. On a phone, open this page in your wallet app:</p>
      <div class="pk-mlinks">${mobileWalletLinks(location.href).map((l) => `<a class="btn ghost" href="${esc(l.href)}">Open in ${esc(l.name)}</a>`).join('')}</div></div>`;
  }
  return `<div class="pk-wbtns">${list.map((w) => `<button class="btn pk-wbtn" data-wallet="${esc(w.name)}"><img src="${esc(w.icon)}" alt="" width="22" height="22">${esc(w.name)}</button>`).join('')}</div>`;
}

const DEPOSIT_STATE: Record<string, string> = { credited: 'credited', held: 'held for a person', dust: 'under the minimum' };
const WITHDRAWAL_STATE: Record<string, string> = { pending: 'on its way', sending: 'on its way', review: 'being reviewed', sent: 'sent', refunded: 'credited back' };

const moveHtml = (what: string, m: WalletMove, state: string, tx?: string) =>
  `<li><span>${what} ${usd(Number(m.amount))}</span><span class="pk-mstate s-${esc(m.state)}">${esc(state)}</span>
    <small>${esc(when(m.created_at))}${tx ? ` · <a href="${explorer('tx', tx)}" target="_blank" rel="noopener">transaction</a>` : ''}</small></li>`;

/** My latest deposits and withdrawals, newest first. */
function movesHtml(lobby: Lobby): string {
  const rows = [
    ...lobby.deposits.map((d) => ({ at: d.created_at, html: moveHtml('Deposit', d, DEPOSIT_STATE[d.state] ?? d.state, d.signature) })),
    ...lobby.withdrawals.map((w) => ({ at: w.created_at, html: moveHtml('Withdrawal', w, WITHDRAWAL_STATE[w.state] ?? w.state, w.txid ?? undefined) })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
  return rows.length ? `<h3 class="pk-h">Wallet activity</h3><ul class="pk-moves">${rows.map((r) => r.html).join('')}</ul>` : '';
}

/** One prize, wherever it is: opening, waiting on keep-or-sell, sent, sold back, refunded or delayed. */
function prizeHtml(p: PrizeView, compact: boolean): string {
  const label = TIERS[p.tier]?.label ?? 'Pack';
  const card = p.pull;
  switch (p.state) {
    case 'pending':
    case 'sending':
      return `<div class="pk-prize" style="--tc:${TIERS[p.tier].color}">${packArt(p.tier, compact ? 64 : 110, 'shake')}
        <p><strong>${esc(label)}</strong><br>${p.choice ? (p.choice === 'sell' ? 'Selling it back…' : 'Sending it to your wallet…') : 'Opening your pack…'}</p>
        ${compact ? '' : prizeStepsHtml(p.choice ? 2 : 0)}</div>`;
    case 'revealed':
      return `<div class="pk-prize" style="--tc:${TIERS[p.tier].color}">
        ${card ? (compact ? cardHtml(card, 'small') : revealHtml(card)) : ''}
        ${compact ? '' : prizeStepsHtml(1)}
        ${choiceHtml({ id: p.id, chooseBy: p.choose_by ? new Date(p.choose_by).getTime() : null, ifNoChoice: p.prefer_cash ? 'sell' : 'keep', sellEstimate: p.sell_estimate }, compact)}</div>`;
    case 'sent':
      return `<div class="pk-prize" style="--tc:${TIERS[p.tier].color}">${card ? cardHtml(card, compact ? 'small' : 'big') : ''}
        <p class="pk-done">In your wallet${p.nft_address ? ` · <a href="${explorer('address', p.nft_address)}" target="_blank" rel="noopener">see it on ${cluster === 'devnet' ? 'devnet' : 'Solscan'}</a>` : ''}</p></div>`;
    case 'cashed':
      return `<div class="pk-prize" style="--tc:${TIERS[p.tier].color}">${card ? cardHtml(card, 'small') : ''}
        <p class="pk-done">Sold back for ${usd(Number(p.cash_amount))}, added to your balance</p></div>`;
    case 'refunded':
      return `<div class="pk-prize" style="--tc:${TIERS[p.tier].color}">${packArt(p.tier, 64)}
        <p class="pk-done">Collector Crypt couldn't sell this pack, so the ${usd(Number(p.price_micro))} pot is in your balance.</p></div>`;
    default:
      return `<div class="pk-prize" style="--tc:${TIERS[p.tier].color}">${packArt(p.tier, 64)}
        <p>Your ${esc(label)} is delayed. It's being retried, and nothing is lost.</p></div>`;
  }
}

/** Bind any keep-or-sell buttons under `el`; `after` runs once the pick is in (or the time is up). */
function bindPrizes(el: HTMLElement, svc: PackService, after: () => void) {
  el.querySelectorAll<HTMLElement>('[data-k="choice"]').forEach((box) => bindChoice(box, async (id, c) => {
    if (!(await svc.choose(id, c))) throw new Error('This card is already on its way.');
  }, (_c, err) => {
    if (err) box.querySelector<HTMLElement>('[data-k="clock"]')!.textContent = friendly(err);
    else setTimeout(after, 1500);
  }));
}

export function openPackBattles(ctx: ModeContext) {
  const { root } = ctx;
  root.className = 'screen-menu';
  window.scrollTo(0, 0);
  const intro = 'Beat another player to win a real graded card from a Collector Crypt pack.';
  if (!ONLINE_CONFIGURED) {
    root.innerHTML = panel('PACK BATTLES', `${intro} Pack Battles need online play, which isn't set up in this build.`,
      `<div class="actions center"><button class="btn ghost" data-a="back">Back</button></div>`);
    root.querySelector('[data-a="back"]')!.addEventListener('click', ctx.back);
    return;
  }
  root.innerHTML = panel('PACK BATTLES', intro,
    `<div data-lobby><p class="note center">Loading…</p></div>
     <div class="actions center"><button class="btn ghost" data-a="back">Back</button></div>`);
  root.querySelector('[data-a="back"]')!.addEventListener('click', ctx.back);
  void loadLobby(ctx);
}

async function loadLobby(ctx: ModeContext, flash?: string) {
  const slot = ctx.root.querySelector<HTMLElement>('[data-lobby]');
  if (!slot) return;
  let svc: PackService;
  let lobby: Lobby;
  try {
    svc = await online(ctx);
    lobby = await svc.lobby();
    // A search left running (another tab, or the app was closed) is cancelled and refunded.
    if (lobby.searching) { await svc.leave(); lobby = await svc.lobby(); }
  } catch (e) {
    if (slot.isConnected) slot.innerHTML = `<p class="pk-gate">${esc(friendly(e))}</p>`;
    return;
  }
  if (!slot.isConnected) return;
  cluster = lobby.real_money ? 'mainnet-beta' : 'devnet';
  const prefer = store.get(PREFER_KEY) === 'sell' ? 'sell' : 'keep';
  const linked = lobby.wallet;
  const cooldown = linked && new Date(linked.withdraw_after).getTime() > Date.now() ? linked.withdraw_after : null;
  slot.innerHTML = `
    ${lobby.real_money ? '' : '<p class="note center pk-devnet">Devnet test: nothing real is bought or paid.</p>'}
    <div class="pk-bar">
      <div class="pk-bal"><span class="lbl">BALANCE</span><strong>${usd(lobby.balance)}</strong><small>${lobby.real_money ? 'USDC' : 'test USDC'}</small></div>
      <div class="pk-acts">
        ${lobby.test_credits ? '<button class="btn" data-a="credit">Get $100 test USDC</button>' : ''}
        ${linked ? `<button class="btn" data-a="deposit">Add funds</button><button class="btn ghost" data-a="withdraw" ${lobby.balance > 0 ? '' : 'disabled'}>Withdraw</button>` : ''}
      </div>
    </div>
    ${flash ? `<p class="pk-flash">${esc(flash)}</p>` : ''}
    ${lobby.paused ? '<p class="pk-gate">Pack Battles are paused right now.</p>' : ''}
    <div class="pk-wallet" data-wallet-box>${linked
      ? `<div class="pk-wal"><span class="lbl">YOUR WALLET</span><strong>${esc(shortAddress(linked.address))}</strong>
          <small>Deposits come from it. Withdrawals, and any card you keep, go to it.${cooldown ? ` Withdrawals open ${esc(when(cooldown))}, after a wallet change.` : ''}</small>
          <button class="link-btn" data-a="relink">Change</button></div>`
      : `<div class="pk-wal"><span class="lbl">LINK YOUR WALLET</span>
          <small>Sign a message to prove it's yours: free, and no transaction. ${lobby.real_money ? 'You need one to play.' : 'You need one to deposit or withdraw.'}</small></div>
          ${walletButtons()}`}</div>
    <div data-money></div>
    <div class="pk-setup">
      ${linked || lobby.real_money ? '' : `<label class="field">Or just a Solana wallet (devnet) for a card you keep
        <input id="pk-wallet" autocomplete="off" spellcheck="false" placeholder="Wallet address" value="${esc(store.get(WALLET_KEY))}">
      </label>`}
      <div class="field">If you don't pick at the reveal
        <div class="seg" id="pk-pref">
          <button data-v="keep" class="${prefer === 'keep' ? 'on' : ''}">Keep the card</button>
          <button data-v="sell" class="${prefer === 'sell' ? 'on' : ''}">Sell it back</button>
        </div>
      </div>
    </div>
    ${lobby.prizes.filter((p) => p.state === 'revealed').map((p) => `<div class="pk-won"><p class="pk-won-h">Your card is waiting: keep it or sell it back</p>${prizeHtml(p, false)}</div>`).join('')}
    <ul class="pk-tiers">${TIER_ORDER.map((code) => {
      const t = lobby.tiers.find((x) => x.code === code);
      if (!t) return '';
      const look = TIERS[code];
      return `<li class="pk-tier ${t.available ? '' : 'paused'}" style="--tc:${look.color}; --tc2:${look.color2}">
        ${packArt(code, 96)}
        <div class="pk-info">
          <strong>${esc(look.label)}</strong>
          <span>Win a ${usd(t.pot)} pack</span>
          <small>Enter for ${usd(entryCost(t))}: your ${usd(t.cost.stake)} half of the pot + ${usd(t.cost.fee)} fee</small>
          ${t.odds ? oddsBarHtml(t.odds, look.label) : ''}
          ${t.available ? '' : `<small class="pk-why">Paused${t.why ? `: ${esc(t.why)}` : ''}</small>`}
        </div>
        <button class="btn primary" data-tier="${code}" ${t.available && !lobby.paused ? '' : 'disabled'}>Battle</button>
      </li>`;
    }).join('')}</ul>
    ${lobby.prizes.some((p) => p.state !== 'revealed') ? `<h3 class="pk-h">Your prizes</h3><ul class="pk-prizes">${lobby.prizes.filter((p) => p.state !== 'revealed').map((p) => `<li>${prizeHtml(p, true)}</li>`).join('')}</ul>` : ''}
    ${movesHtml(lobby)}
    <p class="note center pk-rules">You play a full online game with evenly matched teams. Both players' inputs are signed, and the winner is decided by replaying them, not by either player's word. Leave before the buzzer and you forfeit. A tie refunds both entries, fee included.</p>`;

  const typed = slot.querySelector<HTMLInputElement>('#pk-wallet');
  typed?.addEventListener('change', () => store.set(WALLET_KEY, typed.value.trim()));
  slot.querySelectorAll<HTMLButtonElement>('#pk-pref button').forEach((b) => b.addEventListener('click', () => {
    store.set(PREFER_KEY, b.dataset.v!);
    slot.querySelectorAll('#pk-pref button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  slot.querySelector<HTMLButtonElement>('[data-a="credit"]')?.addEventListener('click', async (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    try {
      await svc.testCredit();
      void loadLobby(ctx, 'Added $100 of test USDC to your balance.');
    } catch (x) {
      void loadLobby(ctx, friendly(x));
    }
  });
  bindLink(ctx, slot, svc, lobby);
  slot.querySelector('[data-a="relink"]')?.addEventListener('click', () => {
    const box = slot.querySelector<HTMLElement>('[data-wallet-box]')!;
    box.innerHTML = `<div class="pk-wal"><span class="lbl">CHANGE WALLET</span>
      <small>Pick the wallet to link instead. After a change, withdrawals wait ${lobby.limits.cooldown_hours} hours, in case someone else got into your account.</small></div>
      ${walletButtons()}<button class="link-btn" data-a="keep-wallet">Keep ${esc(shortAddress(linked!.address))}</button>`;
    box.querySelector('[data-a="keep-wallet"]')!.addEventListener('click', () => void loadLobby(ctx));
    bindLink(ctx, slot, svc, lobby);
  });
  slot.querySelector('[data-a="deposit"]')?.addEventListener('click', () => depositForm(ctx, slot, svc, lobby));
  slot.querySelector('[data-a="withdraw"]')?.addEventListener('click', () => withdrawForm(ctx, slot, svc, lobby));
  slot.querySelectorAll<HTMLButtonElement>('[data-tier]').forEach((b) => b.addEventListener('click', () => {
    const w = linked?.address ?? typed?.value.trim() ?? '';
    if (!validWallet(w)) {
      void loadLobby(ctx, lobby.real_money ? 'Link your wallet first: a card you win is sent to it.' : 'Link your wallet, or enter a Solana wallet address: a card you keep is sent there.');
      return;
    }
    if (!linked) store.set(WALLET_KEY, w);
    const tier = b.dataset.tier as PackTier;
    const t = lobby.tiers.find((x) => x.code === tier)!;
    void search(ctx, svc, tier, entryCost(t), w, store.get(PREFER_KEY) === 'sell');
  }));
  bindPrizes(slot, svc, () => void loadLobby(ctx));
}

/** Wallet buttons in the wallet box link that wallet: connect, sign the server's message, and the server checks it. */
function bindLink(ctx: ModeContext, slot: HTMLElement, svc: PackService, lobby: Lobby) {
  slot.querySelectorAll<HTMLButtonElement>('[data-wallet-box] [data-wallet]').forEach((b) => b.addEventListener('click', async () => {
    slot.querySelectorAll<HTMLButtonElement>('[data-wallet-box] [data-wallet]').forEach((x) => { x.disabled = true; });
    try {
      const w = await connect(b.dataset.wallet!);
      signer = w;
      if (lobby.wallet?.address === w.address) { void loadLobby(ctx, `${shortAddress(w.address)} is already your wallet.`); return; }
      await svc.linkWallet(w.address, (m) => w.signMessage(m));
      void loadLobby(ctx, `Linked ${shortAddress(w.address)}.${lobby.wallet ? ` Withdrawals open again in ${lobby.limits.cooldown_hours} hours.` : ''}`);
    } catch (e) {
      void loadLobby(ctx, friendly(e));
    }
  }));
}

/** Add funds: the server builds the transfer, the linked wallet signs it, and it's credited once Solana finalizes it. */
function depositForm(ctx: ModeContext, slot: HTMLElement, svc: PackService, lobby: Lobby) {
  const box = slot.querySelector<HTMLElement>('[data-money]')!;
  const linked = lobby.wallet!;
  const ready = signer?.address === linked.address;
  box.innerHTML = `<div class="pk-money">
    <h3 class="pk-h">Add funds</h3>
    <p class="note">Send ${lobby.real_money ? 'USDC' : 'devnet USDC'} from ${esc(shortAddress(linked.address))}. It's in your balance once Solana finalizes it, usually within a minute. The smallest deposit is ${usd(lobby.limits.min_deposit)}.</p>
    ${ready ? `<div class="pk-row"><label class="field">Amount in USDC<input id="pk-amt" inputmode="decimal" autocomplete="off" placeholder="25"></label>
      <button class="btn primary" data-a="send">Deposit</button></div>`
      : `<p class="note">Connect ${esc(shortAddress(linked.address))} to sign:</p>${walletButtons()}`}
    <p class="pk-status" data-status></p>
    <button class="link-btn" data-a="close">Close</button></div>`;
  box.querySelector('[data-a="close"]')!.addEventListener('click', () => { box.innerHTML = ''; });
  const status = (t: string) => { box.querySelector<HTMLElement>('[data-status]')!.textContent = t; };
  box.querySelectorAll<HTMLButtonElement>('[data-wallet]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const w = await connect(b.dataset.wallet!);
      if (w.address !== linked.address) { status(`That wallet is ${shortAddress(w.address)}. Switch it to ${shortAddress(linked.address)}, the one you linked.`); return; }
      signer = w;
      depositForm(ctx, slot, svc, lobby);
    } catch (e) {
      status(friendly(e));
    }
  }));
  box.querySelector('[data-a="send"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const amount = micro(box.querySelector<HTMLInputElement>('#pk-amt')!.value);
    if (!amount || amount < lobby.limits.min_deposit) { status(`Enter at least ${usd(lobby.limits.min_deposit)}.`); return; }
    btn.disabled = true;
    try {
      status('Confirm the deposit in your wallet…');
      const sent = await signer!.sign(await svc.depositTx(amount), cluster);
      status('Sent. Waiting for Solana to finalize it…');
      let r = await svc.claim(sent);
      const until = Date.now() + 120_000;
      while (r.state === 'pending' && Date.now() < until && box.isConnected) {
        await new Promise((res) => setTimeout(res, 4000));
        r = await svc.claim({ signature: r.signature });
      }
      if (r.state === 'recorded' && r.credited > 0) void loadLobby(ctx, `Added ${usd(r.credited)} to your balance.`);
      else if (r.state === 'pending') void loadLobby(ctx, 'Your deposit is still finalizing. It shows up in your balance within a few minutes.');
      else void loadLobby(ctx, "That transaction didn't send USDC from your linked wallet, so nothing was credited. Contact support if you think it should have been.");
    } catch (x) {
      btn.disabled = false;
      status(friendly(x));
    }
  });
}

/** Withdraw: off the balance at once, then sent to the linked wallet within a minute. */
function withdrawForm(ctx: ModeContext, slot: HTMLElement, svc: PackService, lobby: Lobby) {
  const box = slot.querySelector<HTMLElement>('[data-money]')!;
  const linked = lobby.wallet!;
  const left = Math.max(0, lobby.limits.daily_withdrawal - lobby.limits.withdrawn_today);
  box.innerHTML = `<div class="pk-money">
    <h3 class="pk-h">Withdraw</h3>
    <p class="note">${lobby.real_money ? 'USDC' : 'Devnet USDC'} goes to ${esc(shortAddress(linked.address))}, the wallet you linked, and nowhere else. From ${usd(lobby.limits.min_withdrawal)}, up to ${usd(left)} more today.</p>
    <div class="pk-row"><label class="field">Amount in USDC<input id="pk-amt" inputmode="decimal" autocomplete="off" placeholder="${usd(lobby.balance).slice(1)}"></label>
      <button class="btn primary" data-a="send">Withdraw</button></div>
    <p class="pk-status" data-status></p>
    <button class="link-btn" data-a="close">Close</button></div>`;
  box.querySelector('[data-a="close"]')!.addEventListener('click', () => { box.innerHTML = ''; });
  const status = (t: string) => { box.querySelector<HTMLElement>('[data-status]')!.textContent = t; };
  box.querySelector('[data-a="send"]')!.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const amount = micro(box.querySelector<HTMLInputElement>('#pk-amt')!.value);
    if (!amount) { status('Enter an amount.'); return; }
    btn.disabled = true;
    try {
      const r = await svc.withdraw(amount);
      void loadLobby(ctx, r.state === 'review'
        ? `Your ${usd(amount)} withdrawal is over the review limit, so a person checks it first. It's off your balance and safe meanwhile.`
        : `${usd(amount)} is on its way to ${shortAddress(linked.address)}. It usually lands within a minute.`);
    } catch (x) {
      btn.disabled = false;
      status(friendly(x));
    }
  });
}

async function search(ctx: ModeContext, svc: PackService, tier: PackTier, cost: number, wallet: string, preferCash: boolean) {
  const { root } = ctx;
  const abort = new AbortController();
  const look = TIERS[tier];
  root.className = 'screen-menu';
  window.scrollTo(0, 0);
  root.innerHTML = panel('SEARCHING', `Looking for a ${look.label} opponent near your skill…`, `
    <div class="pk-search" style="--tc:${look.color}">${packArt(tier, 110, 'float')}
      <p>Your ${usd(cost)} entry is held. Cancel and it comes straight back to your balance.</p></div>
    <div class="actions center"><button class="btn ghost" data-a="cancel">Cancel</button></div>`);
  const back = () => openPackBattles(ctx);
  root.querySelector('[data-a="cancel"]')!.addEventListener('click', () => { abort.abort(); back(); });
  let match: OnlineMatch;
  try {
    match = await svc.find(tier, wallet, preferCash, abort.signal);
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    back();
    setTimeout(() => void loadLobby(ctx, friendly(e)), 0);
    return;
  }
  const home: ModeContext = { ...ctx, back };
  void playOnline(home, {
    sb: supabase(), service: svc.match, match,
    playAgain: back,
    outcomeHtml: '<p class="note center">Judging the game from both players\' signed inputs…</p>',
    stopped: (why) => STOPPED[why],
    leaveForfeits: true,
    afterResult: (slot) => void follow(slot, svc, match.id),
  });
}

/** What a game that stopped early means in a Pack Battle: whoever quit forfeits (judgeMatch.ts). */
const STOPPED: Record<StopReason, string> = {
  left: 'Leaving a Pack Battle forfeits it, so your opponent wins the pack.',
  'opponent-left': 'Leaving a Pack Battle forfeits it, so the pack is yours once the judge has checked the game.',
  lost: 'The judge checks both players\' records: a player who dropped out forfeits. If both of you were still here, a person checks the connection logs before anything moves. If your connection really dropped, contact support.',
  problem: 'A person checks this game before anything moves. Your entry is safe until then.',
};

/** After the buzzer (or a game that stopped early): wait for the judge, then follow the winner's pack to their wallet. */
async function follow(slot: HTMLElement, svc: PackService, matchId: string) {
  const until = Date.now() + 10 * 60_000;
  let nudged = 0;
  let shown = '';
  while (slot.isConnected && Date.now() < until) {
    if (Date.now() - nudged > 10_000) { nudged = Date.now(); void svc.nudge(); }
    const b = await svc.battle(matchId).catch(() => null);
    const html = b ? battleHtml(b) : '';
    if (html && html !== shown) {
      shown = html;
      slot.innerHTML = html;
      bindPrizes(slot, svc, () => {});
    }
    const settled = b && (b.state === 'void' || b.state === 'review' || (b.state === 'won' && (!b.won || ['sent', 'cashed', 'refunded'].includes(b.prize?.state ?? ''))));
    if (settled) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function battleHtml(b: BattleView): string {
  const label = TIERS[b.tier]?.label ?? 'pack';
  if (b.state === 'playing') return '<p class="note center">Judging the game from both players\' signed inputs…</p>';
  if (b.state === 'void') {
    const why = b.outcome === 'tie' ? 'It ended in a tie' : 'The game never got going';
    return `<p class="note center">${why}, so there's no winner. Your entry is back in your balance, fee included.</p>`;
  }
  if (b.state === 'review') {
    return b.outcome === 'disconnect'
      ? '<p class="note center">The connection dropped while you were both still in the game, so a person checks both connection logs before anything moves. Your entry is safe.</p>'
      : '<p class="note center">This game needs a person to check it before anything moves. Your entry is safe.</p>';
  }
  const quit = b.outcome === 'resigned' || b.outcome === 'abandoned';
  if (!b.won) {
    return quit
      ? `<p class="note center">You left before the buzzer, so you forfeit and your opponent wins the ${esc(label)}. If your connection really dropped, contact support.</p>`
      : `<p class="note center">Your opponent wins the ${esc(label)}. Better luck next battle!</p>`;
  }
  const head = quit ? `Your opponent left, so you win the ${esc(label)}!` : `You win the ${esc(label)}!`;
  if (!b.prize) return `<p class="note center">${head} Opening your pack…</p>`;
  return `<div class="pk-won"><p class="pk-won-h">${head}</p>${prizeHtml(b.prize, false)}</div>`;
}
