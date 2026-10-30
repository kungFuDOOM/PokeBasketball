// Pack Battles (devnet test build): beat another player online to win a Collector Crypt pack.
// Enter a tier and your half of the pot (plus your half of the fee) is held from your balance. The game is the same
// online lockstep game as Ranked, with balanced teams and signed inputs. The pokejam-pack-judge Edge Function
// replays both players' inputs to decide the winner, whose pack the payout worker buys and opens; they keep the card
// or sell it back at the reveal. A player who leaves early forfeits; a tie refunds both entries. See migration 20261103.
import './pack.css';
import { esc } from '../../util';
import { ensureHuman, humanDeps } from '../shared/human';
import { panel } from '../shared/matchFlow';
import { playOnline, type StopReason } from '../shared/onlineGame';
import { OnlineError, SupabaseMatchService, type OnlineMatch } from '../shared/onlineMatchService';
import { ONLINE_CONFIGURED, ensureSignedIn, supabase } from '../shared/supabase';
import type { ModeContext } from '../shared/types';
import { bindChoice, cardHtml, choiceHtml, oddsBarHtml, packArt, prizeStepsHtml, revealHtml } from './art';
import { PackService, TIERS, TIER_ORDER, usd, validWallet, type BattleView, type Lobby, type PackTier, type PrizeView } from './service';

const WALLET_KEY = 'pokejam.packWallet';
const PREFER_KEY = 'pokejam.packPrefer';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let service: PackService | null = null;

async function online(ctx: ModeContext): Promise<PackService> {
  const sb = supabase();
  const uid = await ensureSignedIn(sb);
  if (!service) {
    const human = (force: boolean) => ensureHuman(humanDeps(sb), force);
    service = new PackService(sb, new SupabaseMatchService(sb, uid, ['pack'], human), human,
      async () => { await sb.functions.invoke('pokejam-pack-judge', { body: {} }); });
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
const explorer = (kind: 'address' | 'tx', id: string) => `https://explorer.solana.com/${kind}/${encodeURIComponent(id)}?cluster=devnet`;

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
        <p class="pk-done">In your wallet${p.nft_address ? ` · <a href="${explorer('address', p.nft_address)}" target="_blank" rel="noopener">see it on devnet</a>` : ''}</p></div>`;
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
  root.innerHTML = panel('PACK BATTLES', `${intro} Devnet test: nothing real is bought or paid.`,
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
  const prefer = store.get(PREFER_KEY) === 'sell' ? 'sell' : 'keep';
  slot.innerHTML = `
    <div class="pk-bar">
      <div class="pk-bal"><span class="lbl">BALANCE</span><strong>${usd(lobby.balance)}</strong><small>test USDC</small></div>
      ${lobby.test_credits ? '<button class="btn" data-a="credit">Get $100 test USDC</button>' : ''}
    </div>
    ${flash ? `<p class="pk-flash">${esc(flash)}</p>` : ''}
    ${lobby.paused ? '<p class="pk-gate">Pack Battles are paused right now.</p>' : ''}
    <div class="pk-setup">
      <label class="field">Your Solana wallet (devnet), where a card you keep is sent
        <input id="pk-wallet" autocomplete="off" spellcheck="false" placeholder="Wallet address" value="${esc(store.get(WALLET_KEY))}">
      </label>
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
    <p class="note center pk-rules">You play a full online game with evenly matched teams. Both players' inputs are signed, and the winner is decided by replaying them, not by either player's word. Leave before the buzzer and you forfeit. A tie refunds both entries, fee included.</p>`;

  const wallet = slot.querySelector<HTMLInputElement>('#pk-wallet')!;
  wallet.addEventListener('change', () => store.set(WALLET_KEY, wallet.value.trim()));
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
  slot.querySelectorAll<HTMLButtonElement>('[data-tier]').forEach((b) => b.addEventListener('click', () => {
    const w = wallet.value.trim();
    if (!validWallet(w)) { void loadLobby(ctx, 'Enter your Solana wallet address first: a card you keep is sent there.'); return; }
    store.set(WALLET_KEY, w);
    const tier = b.dataset.tier as PackTier;
    const t = lobby.tiers.find((x) => x.code === tier)!;
    void search(ctx, svc, tier, entryCost(t), w, store.get(PREFER_KEY) === 'sell');
  }));
  bindPrizes(slot, svc, () => void loadLobby(ctx));
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
