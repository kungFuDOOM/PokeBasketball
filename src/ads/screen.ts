// The Advertise page: write an ad, see it on the courtside LED board exactly as the game draws it, pick how long it
// runs, and pay from your own wallet, either by burning $PJAM (an hour, a day or a week) or in USDC (a week or a month).
// The live pokejam-ads-live Edge Function builds the burn or the transfer and checks it on-chain; see
// supabase/migrations/20261104_pokejam_ads.sql and 20261125_pokejam_ads_live.sql for how a booking moves. No faucet here.
import './ads.css';
import { COURTS } from '../data/courts';
import { monByDex } from '../data/pokemon';
import { Game } from '../game/game';
import { Renderer } from '../game/render';
import { preload } from '../game/sprites';
import type { TeamDef } from '../game/types';
import { AD_MAX, AD_THEMES, THEME_ORDER, adTextOk, boardAfterAd, cleanAdText, type AdTheme, type BoardAd } from '../data/ads';
import { drawLedBoard } from '../game/ledBoard';
import { esc } from '../util';
import { ADS_CONFIGURED, AdsError, PLANS, PLAN_HOURS, adsApi, explorer, replaceMessage, shortTokens, tokens, type Board, type Booking, type Plan, type Quote } from './api';
import { applyBoard } from './board';
import { USDC_PLANS, USDC_PLAN_HOURS, UsdcPayError, checkTransfer, isUsdcPlan, parseUsdcIntent, pollUsdcConfirm, usd, type UsdcPlan } from './usdcPay';
import { connect, mobileWalletLinks, shortAddress, stopWatching, wallets, type Connected } from './wallet';

const PENDING_KEY = 'pokejam.adPending';
/** USDC intents signed but not yet confirmed (the server finds the payment by the intent's reference key). */
const USDC_PENDING_KEY = 'pokejam.adUsdcPending';
const WALLET_KEY = 'pokejam.adWallet';
const DRAFT_KEY = 'pokejam.adDraft';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/** Courts to preview the ad on (each has its own board colour and text). */
const PREVIEW_COURTS = ['Pallet Town', 'Cerulean Cascades', 'Vermilion Thunder', 'Indigo Elite'];
const previewTeam = (name: string, abbr: string, color: string, color2: string, dexes: number[]): TeamDef =>
  ({ name, abbr, color, color2, human: false, roster: dexes.map(monByDex) });
const PREVIEW_HOME = previewTeam('Pallet Town', 'PAL', '#3b6fd8', '#16224a', [25, 6, 9, 3, 143]);
const PREVIEW_AWAY = previewTeam('Indigo Elite', 'IND', '#4a3c8c', '#120f24', [150, 149, 130, 94, 248]);
/** The close-up's width in board pixels: room for the longest ad and some board text either side. */
const ZOOM_W = 300;
const PLAN_LABEL: Record<Plan, { name: string; per: string }> = {
  hour: { name: '1 Hour', per: 'Try it out' },
  day: { name: '1 Day', per: 'Prime time, all day' },
  week: { name: '1 Week', per: 'Own the week' },
};
const USDC_LABEL: Record<UsdcPlan, { name: string; per: string }> = {
  week: { name: '1 Week', per: 'Seven days on every court' },
  month: { name: '1 Month', per: '30 days, best value' },
};
type PayMethod = 'burn' | 'usdc';

interface State {
  board: Board | null;
  text: string;
  theme: AdTheme;
  plan: Plan;
  /** How the advertiser pays; 'usdc' only where the server offers it (board.usdcPay). */
  pay: PayMethod;
  usdcPlan: UsdcPlan;
  /** ISO, or null for as soon as possible. */
  start: string | null;
  quote: Quote | null;
  court: string;
  wallet: Connected | null;
  balance: bigint | null;
  lamports: number | null;
  busy: boolean;
  step: number;
  error: string;
  done: Booking | null;
  /** The server's word on the text: null while it's checking. */
  verdict: { ok: boolean; message: string | null } | null;
  /** This wallet's ads, once connected. */
  mine: Booking[] | null;
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtLeft = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m >= 48 * 60) return `${Math.round(m / 1440)} days left`;
  if (m >= 120) return `${Math.round(m / 60)} hours left`;
  return m >= 60 ? `1 hour${m > 60 ? ` ${m - 60} min` : ''} left` : `${m} min left`;
};
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/reject|denied|cancel|declin/i.test(msg)) return 'You cancelled in your wallet. Nothing was burned or paid.';
  return msg || 'Something went wrong.';
}

export function openAdvertise(root: HTMLElement, back: () => void) {
  root.className = 'screen-ads';
  window.scrollTo(0, 0);
  let draft: Partial<Pick<State, 'text' | 'theme' | 'plan' | 'pay' | 'usdcPlan'>> = {};
  try { draft = JSON.parse(store.get(DRAFT_KEY) || '{}'); } catch { /* none */ }
  const s: State = {
    board: null, text: typeof draft.text === 'string' ? cleanAdText(draft.text) : '', theme: draft.theme && draft.theme in AD_THEMES ? draft.theme : 'gold',
    plan: draft.plan && PLANS.includes(draft.plan) ? draft.plan : 'day',
    pay: draft.pay === 'usdc' ? 'usdc' : 'burn', usdcPlan: isUsdcPlan(draft.usdcPlan) ? draft.usdcPlan : 'week', start: null, quote: null, court: PREVIEW_COURTS[0],
    wallet: null, balance: null, lamports: null, busy: false, step: 0, error: '', done: null, verdict: null, mine: null,
  };
  let alive = true;
  let raf = 0;
  let quoteTimer = 0;
  let checkTimer = 0;
  let mineTimer = 0;
  /** USDC can be picked only when the server offers it. */
  const usdcOffered = () => !!(s.board?.usdc && s.board.usdcPay);
  const payWith = (): PayMethod => (s.pay === 'usdc' && usdcOffered() ? 'usdc' : 'burn');
  const activePlan = (): Plan | UsdcPlan => (payWith() === 'usdc' ? s.usdcPlan : s.plan);
  const onWallets = () => { if (alive) renderWallet(); };

  root.innerHTML = `
    <div class="ads">
      <nav class="ad-top"><button class="btn ghost" data-a="back">← Back</button><span class="ad-net" data-net hidden></span></nav>
      <header class="ad-hero">
        <p class="ad-kicker">Courtside ads</p>
        <h1>Your name in lights<br><span>on every court.</span></h1>
        <p class="ad-lede">Put your message on the LED board that runs along the sideline in every Poké Jam game. You pay from your own wallet, by <b>burning $PJAM</b> (the tokens leave the supply for good, and nobody receives them, not even us) or <b>in USDC</b>.</p>
        <div class="ad-stats" data-stats>${statHtml('—', 'PJAM burned for ads')}${statHtml('—', 'ads run')}${statHtml('—', 'spots live now')}</div>
      </header>

      <section class="ad-stage" aria-label="Preview">
        <div class="ad-screen">
          <canvas class="ad-court" width="480" height="270" data-court aria-hidden="true"></canvas>
          <canvas class="ad-zoom" width="${ZOOM_W}" height="24" data-zoom role="img" aria-label="Your ad on the LED board"></canvas>
          <span class="ad-live-dot">LIVE PREVIEW</span>
        </div>
        <div class="ad-courts" data-courts>${PREVIEW_COURTS.map((c) => `<button data-court-pick="${esc(c)}" class="${c === s.court ? 'on' : ''}">${esc(COURTS[c].venue.replace(/ (City )?Gym$/, '').replace('Indigo Plateau', 'Indigo'))}</button>`).join('')}</div>
        <p class="ad-note">Drawn by the game's own renderer: this is exactly how players see it. Ads take turns on the board, so yours scrolls past again and again.</p>
      </section>

      <section class="ad-build">
        <div class="ad-form">
          <div class="ad-step"><h2><i>1</i>Your message</h2>
            <label class="ad-input"><input data-text maxlength="${AD_MAX}" autocomplete="off" spellcheck="false" placeholder="YOUR AD HERE" value="${esc(s.text)}"><span data-count></span></label>
            <p class="ad-hint" data-text-hint></p>
          </div>
          <div class="ad-step"><h2><i>2</i>Colours</h2>
            <div class="ad-themes" data-themes>${THEME_ORDER.map((t) => themeChip(t, t === s.theme)).join('')}</div>
          </div>
          <div class="ad-step"><h2><i>3</i>How long</h2>
            <div class="seg ad-pay" data-pay hidden role="group" aria-label="Pay with"><button data-v="burn">Burn $PJAM</button><button data-v="usdc">Pay in USDC</button></div>
            <div class="ad-plans" data-plans></div>
          </div>
          <div class="ad-step"><h2><i>4</i>When</h2>
            <div class="seg ad-when" data-when><button data-v="now" class="on">As soon as possible</button><button data-v="pick">Pick a time</button></div>
            <input class="ad-date" type="datetime-local" data-date hidden>
          </div>
        </div>

        <aside class="ad-checkout" data-checkout></aside>
      </section>

      <section class="ad-section"><h2>Board availability <small>next 7 days, in your time</small></h2>
        <div class="ad-cal" data-cal><p class="note">Loading…</p></div>
        <p class="ad-hint">Each hour shows how many of the board's spots are booked. Tap a free hour to start your ad then.</p>
      </section>

      <section class="ad-section" data-mine-box hidden><h2>Your ads</h2><div data-mine></div></section>

      <section class="ad-section"><h2>On the board now</h2><div data-live><p class="note">Loading…</p></div></section>

      <section class="ad-section ad-how"><h2>How it works</h2>
        <ol>
          <li><b>Write it, see it.</b> The preview is the real board. Pick colours and how long it runs.</li>
          <li><b>Burn or pay to book.</b> Your wallet signs one Solana transaction: a burn of the price from your own $PJAM, or a USDC transfer of the price from your own wallet. The site never holds your tokens or your keys.</li>
          <li><b>Checked on-chain.</b> Our server reads the payment from Solana and puts your ad on the board, in every game, on every court.</li>
        </ol>
        <ul class="ad-fine">
          <li>The board has a few spots, and live ads take turns. If it fills up while you're signing, your ad runs at the next opening for the full time you paid for. A burn is never lost.</li>
          <li>Payments are final: burns can't be undone, and USDC payments aren't refunded unless the law requires it. Every burn becomes airtime: the page, your wallet's history and a scan of the token's own history all look for it, so it's found even if you close the page mid-burn.</li>
          <li>Ads are checked before you burn: no explicit words, slurs, links, giveaway or wallet scams, or posing as staff. If moderators still take one down, you keep the time it had left and can run it with new text. Only wallets banned for abuse lose it.</li>
          <li>One spot per advertiser at a time, so nobody can buy the whole board.</li>
          <li>Every ad is marked AD on the board.</li>
        </ul>
      </section>
    </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  $('[data-a="back"]').addEventListener('click', () => { leave(); back(); });

  function leave() {
    alive = false;
    cancelAnimationFrame(raf);
    stopWatching(onWallets);
  }

  // ---------- preview ----------
  // A real CPU-vs-CPU game on the real renderer, with the draft ad on the board, and a close-up of the board below.
  const courtCanvas = $<HTMLCanvasElement>('[data-court]');
  const zoomCanvas = $<HTMLCanvasElement>('[data-zoom]');
  const zctx = zoomCanvas.getContext('2d')!;
  const previewAds = (): BoardAd[] => [{ text: s.text.trim() || 'YOUR AD HERE', theme: s.theme }];
  // The close-up holds still with the ad in the middle: the scroll that puts one repeat's ad block there.
  const zoomScroll = (ctx: CanvasRenderingContext2D, board: string) => {
    ctx.font = '8px "Press Start 2P", monospace';
    const text = previewAds()[0].text;
    const block = 4 + 12 + Math.ceil(ctx.measureText('AD').width) + 6 + 4 + Math.ceil(ctx.measureText(text).width);
    const msg = Math.ceil(ctx.measureText(`  ★ ${boardAfterAd(board)}  ★ `).width);
    return 4 + block + msg - Math.round((ZOOM_W - block) / 2 - 4);
  };
  let game: Game;
  let renderer: Renderer;
  const newGame = () => {
    game = new Game({ home: PREVIEW_HOME, away: PREVIEW_AWAY, quarterLen: 300, difficulty: 'pro', court: COURTS[s.court] });
    renderer = new Renderer(courtCanvas);
    renderer.showUser = false;
    renderer.ads = previewAds;
    // Skip the opening tip-off: the preview starts with the ball in play.
    for (let i = 0; i < 240; i++) game.update(1 / 60);
    game.events.length = 0;
    game.sfx.length = 0;
  };
  void preload([...PREVIEW_HOME.roster, ...PREVIEW_AWAY.roster]);
  newGame();
  let lastFrame = performance.now();
  let acc = 0;
  const frame = (now: number) => {
    if (!alive || !root.isConnected) { leave(); return; }
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    acc += dt;
    for (; acc >= 1 / 60; acc -= 1 / 60) game.update(1 / 60);
    if (game.phase === 'final') newGame();
    renderer.draw(game, dt);
    game.events.length = 0;
    game.sfx.length = 0;
    const court = COURTS[s.court];
    zctx.imageSmoothingEnabled = false;
    zctx.clearRect(0, 0, ZOOM_W, 24);
    drawLedBoard(zctx, { width: ZOOM_W, top: 2, scroll: zoomScroll(zctx, court.board), t: now / 1000, edge: court.boardColor, hype: false, text: court.board, ads: previewAds() });
    raf = requestAnimationFrame(frame);
  };
  // The LED font must be loaded before the canvas measures text.
  void document.fonts.load('8px "Press Start 2P"').finally(() => { lastFrame = performance.now(); raf = requestAnimationFrame(frame); });

  root.querySelector('[data-courts]')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-court-pick]');
    if (!b) return;
    s.court = b.dataset.courtPick!;
    root.querySelectorAll('[data-court-pick]').forEach((x) => x.classList.toggle('on', x === b));
    newGame();
  });

  // ---------- the form ----------
  const textInput = $<HTMLInputElement>('[data-text]');
  const saveDraft = () => store.set(DRAFT_KEY, JSON.stringify({ text: s.text, theme: s.theme, plan: s.plan, pay: s.pay, usdcPlan: s.usdcPlan }));
  const HINT = "Letters, numbers, spaces and $ ! ? . , &amp; + @ # : ' / % - . Your @handle or $ticker work; links don't.";
  const renderCount = () => {
    const local = !s.text.trim() || adTextOk(s.text);
    const v = s.verdict;
    const bad = !local || (v !== null && !v.ok);
    $('[data-count]').textContent = `${s.text.length}/${AD_MAX}`;
    const hint = $('[data-text-hint]');
    hint.classList.toggle('bad', bad);
    hint.classList.toggle('good', !bad && !!v?.ok && !!s.text.trim());
    hint.innerHTML = !local ? "Some of those characters won't show on the board. " + HINT
      : v && !v.ok ? esc(v.message ?? "That can't run.") : v?.ok && s.text.trim() ? '✓ Ready for the board.' : HINT;
    textInput.classList.toggle('bad', bad);
  };
  // The server has the last word on what may run; it answers as you type.
  const checkText = () => {
    clearTimeout(checkTimer);
    s.verdict = null;
    if (!s.text.trim() || !adTextOk(s.text) || !ADS_CONFIGURED) return;
    const text = s.text;
    checkTimer = window.setTimeout(async () => {
      try {
        const v = await adsApi.check(text);
        if (alive && text === s.text) s.verdict = v;
      } catch { /* the pay button stays off until it answers */ }
      if (alive) { renderCount(); renderCheckout(); }
    }, 350);
  };
  textInput.addEventListener('input', () => {
    const pos = textInput.selectionStart;
    s.text = cleanAdText(textInput.value);
    textInput.value = s.text;
    if (pos !== null) textInput.setSelectionRange(pos, pos);
    checkText();
    renderCount();
    saveDraft();
    renderCheckout();
  });
  renderCount();
  checkText();

  root.querySelector('[data-themes]')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-theme]');
    if (!b) return;
    s.theme = b.dataset.theme as AdTheme;
    root.querySelectorAll('[data-theme]').forEach((x) => x.classList.toggle('on', x === b));
    saveDraft();
  });

  root.querySelector('[data-plans]')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-plan]');
    if (!b) return;
    if (payWith() === 'usdc') s.usdcPlan = b.dataset.plan as UsdcPlan;
    else s.plan = b.dataset.plan as Plan;
    saveDraft();
    renderPlans();
    requote();
  });

  root.querySelector('[data-pay]')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-v]');
    if (!b || s.busy) return;
    s.pay = b.dataset.v === 'usdc' ? 'usdc' : 'burn';
    s.error = '';
    s.quote = null;
    saveDraft();
    renderPlans();
    renderCheckout();
    requote();
  });

  const dateInput = $<HTMLInputElement>('[data-date]');
  const setStart = (iso: string | null) => {
    s.start = iso;
    root.querySelectorAll<HTMLButtonElement>('[data-when] button').forEach((x) => x.classList.toggle('on', x.dataset.v === (iso ? 'pick' : 'now')));
    dateInput.hidden = !iso;
    if (iso) dateInput.value = localInput(new Date(iso));
    requote();
  };
  dateInput.min = localInput(new Date());
  dateInput.max = localInput(new Date(Date.now() + 59 * 86_400_000));
  root.querySelector('[data-when]')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    if (b.dataset.v === 'now') setStart(null);
    else {
      const d = new Date(Date.now() + 3_600_000);
      d.setMinutes(0, 0, 0);
      setStart(d.toISOString());
    }
  });
  dateInput.addEventListener('change', () => {
    const t = Date.parse(dateInput.value);
    if (Number.isFinite(t)) setStart(new Date(t).toISOString());
  });

  function renderPlans() {
    const b = s.board;
    const payEl = $('[data-pay]');
    payEl.hidden = !usdcOffered();
    payEl.querySelectorAll<HTMLButtonElement>('button').forEach((x) => x.classList.toggle('on', x.dataset.v === payWith()));
    $('[data-plans]').classList.toggle('usdc', payWith() === 'usdc');
    if (payWith() === 'usdc') { renderUsdcPlans(); return; }
    const hour = b ? BigInt(b.prices.hour) : null;
    $('[data-plans]').innerHTML = PLANS.map((p) => {
      const price = b ? BigInt(b.prices[p]) : null;
      const full = hour !== null ? hour * BigInt(PLAN_HOURS[p]) : null;
      const save = price !== null && full ? Number(((full - price) * 100n) / full) : 0;
      const perHour = price !== null ? price / BigInt(PLAN_HOURS[p]) : null;
      return `<button class="ad-plan ${p === s.plan ? 'on' : ''}" data-plan="${p}">
        ${save >= 5 ? `<span class="ad-save">${p === 'week' ? 'Best value · ' : ''}Save ${save}%</span>` : ''}
        <strong>${PLAN_LABEL[p].name}</strong>
        <span class="ad-price">${price !== null ? tokens(price, b!.decimals) : '…'}<small>$PJAM</small></span>
        <small>${perHour !== null && p !== 'hour' ? `${shortTokens(perHour, b!.decimals)} an hour · ` : ''}${PLAN_LABEL[p].per}</small>
      </button>`;
    }).join('');
  }
  // USDC: the server's prices (board.usdc), compared per hour with the week.
  function renderUsdcPlans() {
    const prices = s.board?.usdc;
    const dec = s.board?.usdcPay?.decimals ?? 6;
    const week = prices ? BigInt(prices.week) : null;
    $('[data-plans]').innerHTML = USDC_PLANS.map((p) => {
      const price = prices ? BigInt(prices[p]) : null;
      const full = week !== null ? (week * BigInt(USDC_PLAN_HOURS[p])) / 168n : null;
      const save = price !== null && full ? Number(((full - price) * 100n) / full) : 0;
      return `<button class="ad-plan ${p === s.usdcPlan ? 'on' : ''}" data-plan="${p}">
        ${save >= 5 ? `<span class="ad-save">Best value · Save ${save}%</span>` : ''}
        <strong>${USDC_LABEL[p].name}</strong>
        <span class="ad-price">${price !== null ? usd(price, dec) : '…'}<small>USDC</small></span>
        <small>${USDC_LABEL[p].per}</small>
      </button>`;
    }).join('');
  }
  renderPlans();

  function requote() {
    clearTimeout(quoteTimer);
    quoteTimer = window.setTimeout(async () => {
      const plan = activePlan();
      try {
        const q = await adsApi.quote(plan, s.start);
        if (plan !== activePlan()) return;
        s.quote = q;
      } catch (e) {
        s.quote = null;
        s.error = friendly(e);
      }
      if (alive) renderCheckout();
    }, 150);
  }

  // ---------- wallet and checkout ----------
  async function useWallet(name: string, silent = false) {
    try {
      s.wallet = await connect(name, silent);
      store.set(WALLET_KEY, name);
      s.error = '';
      await refreshBalance();
      void loadMine();
    } catch (e) {
      if (!silent) s.error = friendly(e);
    }
    renderCheckout();
  }

  async function refreshBalance() {
    if (!s.wallet) return;
    try {
      const w = await adsApi.wallet(s.wallet.address);
      s.balance = BigInt(w.balance);
      s.lamports = w.lamports;
    } catch {
      s.balance = null;
    }
  }

  function renderWallet() { renderCheckout(); }

  function walletHtml(): string {
    const b = s.board;
    if (s.wallet) {
      const bal = s.balance !== null && b ? `${tokens(s.balance, b.decimals)} $PJAM` : '…';
      return `<div class="ad-wallet">
        <img src="${esc(s.wallet.icon)}" alt="" width="28" height="28">
        <div><strong>${esc(shortAddress(s.wallet.address))}</strong><small>${esc(bal)}</small></div>
        <button class="link-btn" data-a="disconnect">Disconnect</button>
      </div>
`;
    }
    const list = wallets(onWallets);
    if (!list.length) {
      const links = mobileWalletLinks(location.href);
      return `<div class="ad-nowallet"><p>No Solana wallet found in this browser.</p>
        <p class="ad-hint">On a computer, install Phantom, Solflare or Backpack. On a phone, open this page in your wallet app:</p>
        <div class="ad-mlinks">${links.map((l) => `<a class="btn ghost" href="${esc(l.href)}">Open in ${esc(l.name)}</a>`).join('')}</div></div>`;
    }
    return `<div class="ad-connect">${list.map((w) => `<button class="btn ad-wbtn" data-wallet="${esc(w.name)}"><img src="${esc(w.icon)}" alt="" width="22" height="22">${esc(w.name)}</button>`).join('')}</div>`;
  }

  function renderCheckout() {
    const el = $('[data-checkout]');
    const b = s.board;
    const q = s.quote;
    if (s.done) { el.innerHTML = receiptHtml(s.done, b); bindCheckout(); return; }
    if (payWith() === 'usdc') { renderUsdcCheckout(el); return; }
    const qp = q && q.plan === s.plan ? q : null;
    const price = qp?.price ? BigInt(qp.price) : b ? BigInt(b.prices[s.plan]) : null;
    const dec = b?.decimals ?? 6;
    const textOk = adTextOk(s.text);
    const short = s.wallet && s.balance !== null && price !== null && s.balance < price;
    const noSol = s.wallet && s.lamports !== null && s.lamports < 20_000;
    const can = !!(b && !b.paused && qp && textOk && s.verdict?.ok && s.wallet && !short && !noSol && !s.busy);
    const steps = ['Booking', `Approve in ${s.wallet?.name ?? 'your wallet'}`, 'Burning on Solana', 'On the board'];
    el.innerHTML = `
      <h2>Checkout</h2>
      <div class="ad-sum">
        <div class="ad-chip" style="${chipStyle(s.theme)}"><i>AD</i><span>${esc(s.text.trim() || 'YOUR AD HERE')}</span></div>
        <dl>
          <dt>Runs</dt><dd>${qp ? `${esc(fmtTime(qp.starts_at))} → ${esc(fmtTime(qp.ends_at))}` : '…'}</dd>
          <dt>Length</dt><dd>${PLAN_LABEL[s.plan].name}</dd>
          <dt>Burn</dt><dd class="ad-burn">${price !== null ? `${tokens(price, dec)} <small>$PJAM</small>` : '…'}</dd>
        </dl>
        ${qp?.moved ? `<p class="ad-warn">The board is full at that time, so this would start at the next opening.</p>` : ''}
      </div>
      ${walletHtml()}
      ${b?.paused ? '<p class="ad-err">Ad sales are paused right now.</p>' : ''}
      ${short ? `<p class="ad-err">This wallet has ${tokens(s.balance!, dec)} $PJAM; this ad burns ${tokens(price!, dec)}.</p>` : ''}
      ${noSol ? '<p class="ad-err">This wallet needs a little SOL for the network fee.</p>' : ''}
      ${s.text && (!textOk || s.verdict?.ok === false) ? '<p class="ad-err">Fix your message first (see above).</p>' : ''}
      <button class="btn primary big ad-go" data-a="burn"${can ? '' : ' disabled'}>${s.busy ? 'Working…' : price !== null ? `Burn ${tokens(price, dec)} $PJAM` : 'Burn $PJAM'}</button>
      ${s.step ? `<ol class="ad-steps">${steps.map((x, i) => `<li class="${i + 1 < s.step ? 'done' : i + 1 === s.step ? 'on' : ''}">${esc(x)}</li>`).join('')}</ol>` : ''}
      ${s.error ? `<p class="ad-err">${esc(s.error)}</p>` : ''}
      <p class="ad-fineprint">Burning is permanent. Your wallet shows exactly what you sign: one burn of ${price !== null ? tokens(price, dec) : 'the price'} $PJAM from your own account, and a memo naming this booking.</p>`;
    bindCheckout();
  }

  function renderUsdcCheckout(el: HTMLElement) {
    const b = s.board;
    const q = s.quote && s.quote.plan === s.usdcPlan ? s.quote : null;
    const dec = b?.usdcPay?.decimals ?? 6;
    const price = q?.usdc ? BigInt(q.usdc) : b?.usdc ? BigInt(b.usdc[s.usdcPlan]) : null;
    const textOk = adTextOk(s.text);
    const noSol = s.wallet && s.lamports !== null && s.lamports < 20_000;
    const can = !!(b && !b.paused && q?.usdc && textOk && s.verdict?.ok && s.wallet && !noSol && !s.busy);
    const steps = ['Booking', `Approve in ${s.wallet?.name ?? 'your wallet'}`, 'Confirming on Solana', 'On the board'];
    const to = b?.usdcPay ? shortAddress(b.usdcPay.receiver) : 'us';
    el.innerHTML = `
      <h2>Checkout</h2>
      <div class="ad-sum">
        <div class="ad-chip" style="${chipStyle(s.theme)}"><i>AD</i><span>${esc(s.text.trim() || 'YOUR AD HERE')}</span></div>
        <dl>
          <dt>Runs</dt><dd>${q ? `${esc(fmtTime(q.starts_at))} → ${esc(fmtTime(q.ends_at))}` : '…'}</dd>
          <dt>Length</dt><dd>${USDC_LABEL[s.usdcPlan].name}</dd>
          <dt>Pay</dt><dd class="ad-burn ad-usdc">${price !== null ? `${usd(price, dec)} <small>USDC</small>` : '…'}</dd>
        </dl>
        ${q?.moved ? `<p class="ad-warn">The board is full at that time, so this would start at the next opening.</p>` : ''}
      </div>
      ${walletHtml()}
      ${b?.paused ? '<p class="ad-err">Ad sales are paused right now.</p>' : ''}
      ${noSol ? '<p class="ad-err">This wallet needs a little SOL for the network fee.</p>' : ''}
      ${s.text && (!textOk || s.verdict?.ok === false) ? '<p class="ad-err">Fix your message first (see above).</p>' : ''}
      <button class="btn primary big ad-go" data-a="usdc"${can ? '' : ' disabled'}>${s.busy ? 'Working…' : price !== null ? `Pay ${usd(price, dec)} USDC` : 'Pay in USDC'}</button>
      ${s.step ? `<ol class="ad-steps">${steps.map((x, i) => `<li class="${i + 1 < s.step ? 'done' : i + 1 === s.step ? 'on' : ''}">${esc(x)}</li>`).join('')}</ol>` : ''}
      ${s.error ? `<p class="ad-err">${esc(s.error)}</p>` : ''}
      <p class="ad-fineprint">Payments are final (no refunds unless the law requires it). Your wallet shows exactly what you sign: one transfer of ${price !== null ? usd(price, dec) : 'the price'} USDC from your own account to ${esc(to)}'s USDC account, and a memo naming this booking. The page checks the transfer before your wallet sees it.</p>`;
    bindCheckout();
  }

  function bindCheckout() {
    const el = $('[data-checkout]');
    el.querySelectorAll<HTMLButtonElement>('[data-wallet]').forEach((x) => x.addEventListener('click', () => void useWallet(x.dataset.wallet!)));
    el.querySelector('[data-a="disconnect"]')?.addEventListener('click', async () => {
      await s.wallet?.disconnect();
      s.wallet = null;
      s.balance = null;
      s.mine = null;
      store.set(WALLET_KEY, '');
      renderMine();
      renderCheckout();
    });
    el.querySelector('[data-a="burn"]')?.addEventListener('click', () => void burn());
    el.querySelector('[data-a="usdc"]')?.addEventListener('click', () => void payUsdc());
    el.querySelector('[data-a="another"]')?.addEventListener('click', () => { s.done = null; s.step = 0; renderCheckout(); requote(); });
  }

  const pending = (): { id: string; at: number }[] => {
    try { return (JSON.parse(store.get(PENDING_KEY) || '[]') as { id: string; at: number }[]).filter((p) => Date.now() - p.at < 86_400_000); } catch { return []; }
  };
  const setPending = (list: { id: string; at: number }[]) => store.set(PENDING_KEY, JSON.stringify(list.slice(-10)));

  async function burn() {
    if (!s.wallet || s.busy || !s.board) return;
    s.busy = true;
    s.error = '';
    s.step = 1;
    renderCheckout();
    let id = '';
    try {
      // The price the page shows: if the server's has changed since, nothing is signed and the page shows the new one.
      const expect = (s.quote?.plan === s.plan ? s.quote.price : null) ?? s.board.prices[s.plan];
      let prep;
      try {
        prep = await adsApi.prepare({ wallet: s.wallet.address, text: s.text.trim(), theme: s.theme, plan: s.plan, start: s.start, expect });
      } catch (e) {
        if (e instanceof AdsError && e.info.price) void loadBoard();
        throw e;
      }
      id = prep.booking.id;
      s.step = 2;
      renderCheckout();
      // Nothing is burned unless the wallet signs: a refusal here costs nothing.
      const proof = await s.wallet.sign(prep.tx, prep.cluster);
      setPending([...pending(), { id, at: Date.now() }]);
      s.step = 3;
      renderCheckout();
      let r = await adsApi.confirm(id, proof);
      for (let i = 0; r.booking.state === 'pending' && r.landing && i < 8; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        r = await adsApi.confirm(id, proof.signature ? { signature: proof.signature } : {});
      }
      if (r.booking.state === 'pending') {
        if (r.expired || r.notBurned) {
          setPending(pending().filter((p) => p.id !== id));
          throw new AdsError(r.error ?? "Your burn didn't go through, so nothing was burned. Try again.");
        }
        if (r.error) throw new AdsError(r.error);
        throw new AdsError("Your burn is still confirming on Solana. It's saved: your ad goes up as soon as it lands, even if you close this page.");
      }
      setPending(pending().filter((p) => p.id !== id));
      s.step = 4;
      s.done = r.booking;
      await refreshBalance();
      void loadBoard();
      void loadMine();
    } catch (e) {
      s.error = friendly(e);
      if (s.step < 3) s.step = 0;
    }
    s.busy = false;
    if (alive) renderCheckout();
  }

  // ---------- paying in USDC ----------
  const usdcPending = (): { id: string; at: number }[] => {
    try { return (JSON.parse(store.get(USDC_PENDING_KEY) || '[]') as { id: string; at: number }[]).filter((p) => Date.now() - p.at < 86_400_000); } catch { return []; }
  };
  const setUsdcPending = (list: { id: string; at: number }[]) => store.set(USDC_PENDING_KEY, JSON.stringify(list.slice(-10)));
  const dropUsdcPending = (id: string) => setUsdcPending(usdcPending().filter((p) => p.id !== id));

  async function payUsdc() {
    if (!s.wallet || s.busy || !s.board?.usdc) return;
    const plan = s.usdcPlan;
    s.busy = true;
    s.error = '';
    s.step = 1;
    renderCheckout();
    let id = '';
    try {
      const expect = (s.quote?.plan === plan ? s.quote.usdc : null) ?? s.board.usdc[plan];
      let raw;
      try {
        raw = await adsApi.usdcIntent({ wallet: s.wallet.address, text: s.text.trim(), theme: s.theme, plan, start: s.start, expect });
      } catch (e) {
        if (e instanceof AdsError && e.info.price) void loadBoard();
        throw e;
      }
      const intent = parseUsdcIntent(raw);
      // The page rebuilds the transfer itself: the wallet is asked to sign only the exact payment for this ad.
      await checkTransfer(intent, { payer: s.wallet.address, expectAmount: expect });
      id = intent.id;
      s.step = 2;
      renderCheckout();
      // Nothing moves unless the wallet signs: a refusal here costs nothing.
      const proof = await s.wallet.sign(intent.tx, intent.cluster);
      setUsdcPending([...usdcPending(), { id, at: Date.now() }]);
      s.step = 3;
      renderCheckout();
      let first = true;
      const r = await pollUsdcConfirm(async () => {
        // Send the signed transaction (or its signature) once; after that, the signature or the reference key finds it.
        const p = first ? proof : proof.signature ? { signature: proof.signature } : {};
        first = false;
        return adsApi.usdcConfirm(id, p);
      }, { stop: () => !alive });
      if (r === 'timeout') {
        throw new AdsError("Your payment is still confirming on Solana. It's saved: your ad goes up as soon as it lands, even if you close this page.");
      }
      dropUsdcPending(id);
      s.step = 4;
      if (r.ad) s.done = r.ad;
      void refreshBalance();
      void loadBoard();
      void loadMine();
    } catch (e) {
      // Definitely not paid (refused, expired unseen, or failed on-chain): no need to keep looking for it.
      if (id && e instanceof AdsError && (e.info.expired || e.info.notPaid || e.info.code === 'signature_used' || e.info.code === 'intent_done')) dropUsdcPending(id);
      s.error = e instanceof UsdcPayError ? e.message : friendly(e);
      if (s.step < 3) s.step = 0;
    }
    s.busy = false;
    if (alive) renderCheckout();
  }

  // ---------- your ads ----------
  async function loadMine() {
    clearTimeout(mineTimer);
    if (!s.wallet) return;
    const w = s.wallet.address;
    try {
      const { ads } = await adsApi.mine(w);
      if (!alive || s.wallet?.address !== w) return;
      s.mine = ads;
    } catch { /* keep what we had */ }
    renderMine();
    // While a burn is still landing, keep looking.
    if (s.mine?.some((a) => a.state === 'pending' && pending().some((p) => p.id === a.id))) mineTimer = window.setTimeout(() => void loadMine(), 8000);
  }

  function mineStatus(a: Booking): string {
    const now = Date.now();
    switch (a.state) {
      case 'pending': return pending().some((p) => p.id === a.id) ? '<span class="ad-tag wait">Waiting for your burn to land…</span>' : '<span class="ad-tag">Not paid (nothing burned)</span>';
      case 'dust': return '<span class="ad-tag bad">Burn too small to run</span>';
      case 'removed':
        if (a.banned) return `<span class="ad-tag bad">Taken down: wallet banned</span>`;
        if (a.replaced_by) return '<span class="ad-tag">Taken down, replaced with new text</span>';
        return `<span class="ad-tag bad">Taken down${a.removed_reason ? `: ${esc(a.removed_reason)}` : ''}</span>
          ${(a.removed_left ?? 0) >= 60 ? `<span class="ad-keep">${esc(fmtLeft((a.removed_left ?? 0) * 1000))}: run it with new text.
            <button class="btn small" data-replace="${esc(a.id)}">Use my message above</button></span>` : ''}`;
      default: {
        const st = Date.parse(a.starts_at!);
        const en = Date.parse(a.ends_at!);
        if (en <= now) return `<span class="ad-tag">Ran ${esc(fmtTime(a.starts_at!))} → ${esc(fmtTime(a.ends_at!))}</span>`;
        if (st > now) return `<span class="ad-tag">Starts ${esc(fmtTime(a.starts_at!))}${a.moved ? ' (next opening)' : ''}</span>`;
        return `<span class="ad-tag live">Live · ${esc(fmtLeft(en - now))}</span>`;
      }
    }
  }

  function renderMine() {
    const box = $('[data-mine-box]');
    const list = (s.mine ?? []).filter((a) => a.state !== 'pending' || pending().some((p) => p.id === a.id));
    box.hidden = !s.wallet || !list.length;
    $('[data-mine]').innerHTML = `<ul class="ad-livelist">${list.map((a) => `<li>
      <div class="ad-chip" style="${chipStyle(a.theme as AdTheme)}"><i>AD</i><span>${esc(a.text)}</span></div>
      ${mineStatus(a)}${s.board ? txLink(a, s.board) : ''}
    </li>`).join('')}</ul><p class="ad-err" data-mine-err hidden></p>`;
  }

  root.querySelector('[data-mine]')!.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-replace]');
    if (!btn || !s.wallet) return;
    const err = $('[data-mine-err]');
    err.hidden = true;
    const text = s.text.trim();
    if (!text || !s.verdict?.ok) {
      err.hidden = false;
      err.textContent = 'Write a message above that passes the check first.';
      return;
    }
    btn.disabled = true;
    try {
      const sig = await s.wallet.signMessage(replaceMessage(btn.dataset.replace!, text, s.theme));
      if (!sig) throw new AdsError(`${s.wallet.name} can't sign messages, so it can't change the ad here.`);
      await adsApi.replace(btn.dataset.replace!, text, s.theme, sig);
      void loadBoard();
      await loadMine();
    } catch (x) {
      err.hidden = false;
      err.textContent = friendly(x);
      btn.disabled = false;
    }
  });

  // A burn or a USDC payment whose page closed before it was confirmed is picked up here.
  async function resume() {
    for (const p of usdcPending()) {
      try {
        // No signature: the server looks the payment up by the intent's reference key.
        const r = await adsApi.usdcConfirm(p.id);
        if (r.status === 'paid') {
          dropUsdcPending(p.id);
          if (r.ad && alive && !s.done) { s.done = r.ad; renderCheckout(); }
        }
      } catch (e) {
        if (e instanceof AdsError && (e.info.code === 'no_intent' || e.info.code === 'settings_changed')) dropUsdcPending(p.id);
      }
    }
    for (const p of pending()) {
      try {
        const r = await adsApi.confirm(p.id);
        if (r.booking.state !== 'pending' || Date.now() - p.at > 86_400_000) {
          setPending(pending().filter((x) => x.id !== p.id));
          if (r.booking.state === 'paid' && alive) { s.done = r.booking; renderCheckout(); }
        }
      } catch { /* try again next visit */ }
    }
  }

  // ---------- board, calendar, live ads ----------
  async function loadBoard() {
    try {
      const b = await adsApi.board();
      if (!alive) return;
      s.board = b;
      applyBoard(b);
      renderBoard();
    } catch (e) {
      if (!alive) return;
      $('[data-live]').innerHTML = `<p class="ad-err">${esc(friendly(e))}</p>`;
      $('[data-cal]').innerHTML = '';
    }
  }

  function renderBoard() {
    const b = s.board!;
    const net = $('[data-net]');
    net.hidden = b.cluster !== 'devnet';
    net.textContent = 'DEVNET TEST';
    const burned = BigInt(b.totals.burned);
    const pct = BigInt(b.supply) + burned > 0n ? Number((burned * 1_000_000n) / (BigInt(b.supply) + burned)) / 10_000 : 0;
    $('[data-stats]').innerHTML = statHtml(shortTokens(burned, b.decimals), `PJAM burned for ads${pct ? ` · ${pct < 0.01 ? '<0.01' : pct.toFixed(2)}% of supply` : ''}`, true)
      + statHtml(String(b.totals.ads), b.totals.ads === 1 ? 'ad run' : 'ads run')
      + statHtml(`${b.live.length}/${b.spots}`, 'spots live now');
    $('[data-live]').innerHTML = b.live.length
      ? `<ul class="ad-livelist">${b.live.map((a) => `<li><div class="ad-chip" style="${chipStyle(a.theme)}"><i>AD</i><span>${esc(a.text)}</span></div>
          <small>${esc(fmtLeft(Date.parse(a.ends_at) - Date.now()))}${txLink(a, b, ' · ')}</small>
          <span class="ad-report" data-report="${esc(a.id)}"><button class="link-btn" data-r="open">Report</button></span></li>`).join('')}</ul>`
      : '<p class="note">Nobody yet: the board is showing YOUR AD HERE. Be the first.</p>';
    renderCalendar(b);
    renderPlans();
    requote();
  }

  function renderCalendar(b: Board) {
    const runs = b.booked.map((x) => [Date.parse(x.starts_at), Date.parse(x.ends_at)] as const);
    const start = new Date();
    start.setMinutes(0, 0, 0);
    const days: string[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() + d);
      const cells: string[] = [];
      for (let h = 0; h < 24; h++) {
        const t = new Date(day);
        t.setHours(h);
        const at = t.getTime();
        const past = at + 3_600_000 <= Date.now();
        const used = runs.filter(([a, z]) => a < at + 3_600_000 && z > at).length;
        const full = used >= b.spots;
        cells.push(`<button class="c u${Math.min(used, 3)}${full ? ' full' : ''}${past ? ' past' : ''}" data-at="${at}" title="${esc(t.toLocaleString(undefined, { weekday: 'short', hour: 'numeric' }))}: ${used}/${b.spots} booked"${past || full ? ' disabled' : ''}></button>`);
      }
      days.push(`<div class="ad-day"><span>${esc(day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }))}</span>${cells.join('')}</div>`);
    }
    $('[data-cal]').innerHTML = `<div class="ad-hours"><span></span>${[0, 6, 12, 18].map((h) => `<b style="grid-column:${h + 2}">${new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })}</b>`).join('')}</div>
      ${days.join('')}
      <div class="ad-legend"><span><i class="c u0"></i>Free</span><span><i class="c u1"></i>Some spots booked</span><span><i class="c full"></i>Full</span></div>`;
  }

  // Reporting flags an ad for moderators; it never takes one down by itself.
  root.querySelector('[data-live]')!.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-r]');
    const box = btn?.closest<HTMLElement>('[data-report]');
    if (!btn || !box) return;
    if (btn.dataset.r === 'open') {
      box.innerHTML = `Report as <button class="link-btn" data-r="offensive">offensive</button> · <button class="link-btn" data-r="scam">a scam</button> · <button class="link-btn" data-r="other">other</button>`;
      return;
    }
    box.textContent = 'Sending…';
    try {
      await adsApi.report(box.dataset.report!, btn.dataset.r as 'offensive' | 'scam' | 'other');
      box.textContent = 'Thanks: a moderator will look at it.';
    } catch (x) {
      box.textContent = friendly(x);
    }
  });

  root.querySelector('[data-cal]')!.addEventListener('click', (e) => {
    const c = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-at]');
    if (!c || c.disabled) return;
    const at = Number(c.dataset.at);
    setStart(at <= Date.now() ? null : new Date(at).toISOString());
    $('[data-checkout]').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // ---------- start ----------
  renderCheckout();
  if (!ADS_CONFIGURED) {
    $('[data-checkout]').innerHTML = '<p class="ad-err">Ads aren\'t set up in this build.</p>';
    return;
  }
  void loadBoard().then(resume);
  const last = store.get(WALLET_KEY);
  if (last) {
    // Wallets register a moment after the page loads.
    const tryLast = () => { if (!s.wallet && wallets().some((w) => w.name === last)) void useWallet(last, true); };
    wallets(tryLast);
    tryLast();
  }
}

/** The ad's payment on Solscan: its burn, or its USDC transfer. */
function txLink(a: { burn_sig?: string | null; usdc_sig?: string | null }, board: Board, sep = ' '): string {
  const [sig, label] = a.burn_sig ? [a.burn_sig, 'burn'] : a.usdc_sig ? [a.usdc_sig, 'payment'] : [null, ''];
  if (!sig) return '';
  const link = `<a href="${esc(explorer('tx', sig, board.cluster))}" target="_blank" rel="noopener">${label}</a>`;
  return sep === ' ' ? ` <small>${link}</small>` : `${sep}${link}`;
}

function statHtml(big: string, label: string, fire = false) {
  return `<div class="ad-stat${fire ? ' fire' : ''}"><strong>${esc(big)}</strong><span>${label}</span></div>`;
}

function chipStyle(t: AdTheme) {
  const th = AD_THEMES[t];
  return `--bg:${th.bg};--fg:${th.color};--bd:${th.border};--tb:${th.tagBg};--tf:${th.tagColor}`;
}

function themeChip(t: AdTheme, on: boolean) {
  return `<button class="ad-theme ${on ? 'on' : ''}" data-theme="${t}" style="${chipStyle(t)}" aria-label="${esc(AD_THEMES[t].label)}"><span><i>AD</i></span><small>${esc(AD_THEMES[t].label)}</small></button>`;
}

function receiptHtml(b: Booking, board: Board | null) {
  if (b.state !== 'paid') {
    return `<div class="ad-receipt"><p class="ad-kicker">Burn received</p>
      <h2>${b.state === 'dust' ? 'Too small to run' : 'Not on the board'}</h2>
      <p class="ad-warn">${b.state === 'dust' ? 'That burn was worth less than a minute of airtime.' : 'This wallet is banned from advertising, so the ad stays down.'}</p>
      <button class="btn" data-a="another">Back</button></div>`;
  }
  const live = b.starts_at && Date.parse(b.starts_at) <= Date.now() + 60_000;
  const dec = board?.decimals ?? 6;
  const usdcPaid = b.pay_method === 'usdc';
  const sig = usdcPaid ? b.usdc_sig : b.burn_sig;
  return `<div class="ad-receipt">
    <p class="ad-kicker">${live ? 'You\'re on the board' : 'Booked'}</p>
    <h2>${live ? 'Your ad is live!' : `Your ad starts ${esc(fmtTime(b.starts_at!))}`}</h2>
    <div class="ad-chip big" style="${chipStyle(b.theme)}"><i>AD</i><span>${esc(b.text)}</span></div>
    <dl>
      <dt>Runs</dt><dd>${esc(fmtTime(b.starts_at!))} → ${esc(fmtTime(b.ends_at!))}</dd>
      ${usdcPaid ? `<dt>Paid</dt><dd class="ad-burn ad-usdc">${usd(b.price, board?.usdcPay?.decimals ?? 6)} <small>USDC</small></dd>`
        : `<dt>Burned</dt><dd class="ad-burn">${tokens(b.price, dec)} <small>$PJAM</small></dd>`}
    </dl>
    ${b.moved ? '<p class="ad-warn">The board filled up while you were signing, so your ad runs at the next opening, for the full time you paid for.</p>' : ''}
    ${sig && board ? `<a class="btn ghost" href="${esc(explorer('tx', sig, board.cluster))}" target="_blank" rel="noopener">See the ${usdcPaid ? 'payment' : 'burn'} on Solscan</a>` : ''}
    <button class="btn" data-a="another">Book another</button>
  </div>`;
}
