// A live Pack Battle against another player: waiting room, snake draft, the game, the result.
// The server runs the draft and the authoritative game; this screen shows it and sends your input.

import { POKEMON, POSITIONS, monByDex, spriteUrl } from '../data/pokemon';
import { courtFor } from '../data/courts';
import { PACK_TIERS } from '../battles/service';
import type { Audio } from '../game/audio';
import { Hud } from '../game/hud';
import { Input } from '../game/input';
import { Renderer } from '../game/render';
import { preload } from '../game/sprites';
import { TICK, packInput } from '../game/sync';
import type { Game } from '../game/game';
import type { HttpBackend } from '../net/http';
import { LockstepClient } from '../net/lockstep';
import type { BattleView, DraftView, PullView, ServerMsg } from '../net/protocol';
import { cardHtml, packSvg } from '../ui/pack';
import { esc, tier } from '../util';
import { monCard } from './draft';
import { controlsHtml } from './menu';
import { resultsScreen } from './results';

export interface OnlineActions {
  /** Back to the lobby, optionally with a message. */
  lobby(flash?: string): void;
  prizes(): void;
  menu(): void;
}

export function onlineMatch(root: HTMLElement, api: HttpBackend, battle: BattleView, audio: Audio, act: OnlineActions) {
  const side = battle.side!;
  const them = side === 0 ? battle.guest : battle.host;
  let ws: WebSocket | null = null;
  let closed = false;
  let retries = 0;
  let client: LockstepClient | null = null;
  let view: { stop(): void } | null = null;
  let draftTimer = 0;
  let presence: { connected: [boolean, boolean]; forfeitAt: number | null } = { connected: [true, true], forfeitAt: null };
  let lastDraft: DraftView | null = null;
  let draftFilter = 'ALL';
  let selected: number | null = null;
  let pull: PullView | null = battle.pull;
  let revealTimer = 0;

  const send = (m: object) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

  function leave(flash?: string) {
    closed = true;
    window.clearInterval(draftTimer);
    window.clearInterval(revealTimer);
    window.clearInterval(presenceTimer);
    view?.stop();
    ws?.close();
    act.lobby(flash);
  }

  function connect() {
    ws = new WebSocket(api.socketUrl(battle.id));
    ws.onopen = () => { retries = 0; };
    ws.onmessage = (e) => onMessage(JSON.parse(String(e.data)) as ServerMsg);
    ws.onclose = () => {
      if (closed) return;
      // Reconnect quickly: the game is paused for both players while one of you is missing.
      if (retries++ < 12) {
        banner('Connection lost. Reconnecting…');
        window.setTimeout(connect, Math.min(4000, 500 * retries));
      } else leave('Lost connection to the battle.');
    };
  }

  function onMessage(m: ServerMsg) {
    if (m.t === 'hello') {
      client ??= new LockstepClient(side, send, (g) => mountGame(g), false);
      banner('');
    } else if (m.t === 'wait') {
      waiting();
    } else if (m.t === 'draft') {
      lastDraft = m.draft;
      draft();
    } else if (m.t === 'buying') {
      buying();
    } else if (m.t === 'pull') {
      pull = m.pull;
      reveal(m.pull, m.startsAt);
    } else if (m.t === 'presence') {
      presence = { connected: m.connected, forfeitAt: m.forfeitAt };
      presenceBanner();
    } else if (m.t === 'final') {
      final(m.battle);
      return;
    } else if (m.t === 'error') {
      banner(m.message);
    }
    client?.handle(m);
  }

  // ------------------------------------------------------------ waiting room

  function waiting() {
    window.clearInterval(draftTimer);
    root.className = 'screen-quick';
    const t = PACK_TIERS[battle.tier];
    root.innerHTML = `
      <div class="quick">
        <section class="card next battle-next room" style="--tc:${t.color}">
          <p class="eyebrow">Pack Battle · ${esc(t.label)} · ${battle.quarterLen / 60}-min quarters</p>
          <div class="stake">${packSvg(battle.tier, 84, 'float')}<span>Winner gets</span><b>${t.label}</b></div>
          <p class="waiting big"><i class="ball-spin" aria-hidden="true"></i>Waiting for ${esc(them?.teamName ?? 'your challenger')} to join…</p>
          <p class="note center">Keep this open. The draft starts as soon as you're both here. If they don't show, the battle is called off and you both get your entry back.</p>
          <div class="actions center"><button class="btn ghost" data-a="leave">Back to battles</button></div>
        </section>
        <p class="net-banner" role="status" hidden></p>
      </div>`;
    root.querySelector('[data-a="leave"]')!.addEventListener('click', () => leave('Your battle is still in Your battles. Open it again to play.'));
  }

  // ------------------------------------------------------------ draft

  function draft() {
    const d = lastDraft!;
    root.className = 'screen-draft';
    const pickNo = d.picks.length;
    const myTurn = d.order[pickNo] === side;
    const roster = (s: 0 | 1) => d.picks.filter((_, i) => d.order[i] === s).map(monByDex);
    const slots = (s: 0 | 1) => {
      const r = roster(s);
      return `<ul class="od-slots">${Array.from({ length: 5 }, (_, i) => r[i]
        ? `<li><img src="${spriteUrl(r[i].dex)}" alt=""><b class="t-${tier(r[i].ovr)}">${r[i].ovr}</b><small>${r[i].pos}</small></li>`
        : '<li class="empty"></li>').join('')}</ul>`;
    };
    const pool = POKEMON.filter((m) => !d.picks.includes(m.dex) && (draftFilter === 'ALL' || m.pos === draftFilter)).sort((a, b) => b.ovr - a.ovr);
    if (selected !== null && d.picks.includes(selected)) selected = null;
    const sel = selected !== null ? monByDex(selected) : null;
    root.innerHTML = `
      <div class="draft online-draft">
        <header class="draft-head">
          <button class="btn ghost small" data-a="leave">Leave</button>
          <div class="status">
            <span class="round">PACK BATTLE DRAFT · PICK ${Math.min(pickNo + 1, d.order.length)} OF ${d.order.length}</span>
            <span class="otc ${myTurn ? 'you' : ''}">${myTurn ? "You're on the clock" : `${esc(d.teamNames[1 - side])} is picking…`}</span>
            <span class="clock big" data-k="clock"></span>
          </div>
        </header>
        <div class="od-teams">
          <div class="od-team you"><h4>${esc(d.teamNames[side])} <small>You</small></h4>${slots(side)}</div>
          <div class="od-team"><h4>${esc(d.teamNames[1 - side])}</h4>${slots((1 - side) as 0 | 1)}</div>
        </div>
        <div class="filters" role="tablist">${(['ALL', ...POSITIONS] as const).map((p) => `<button data-f="${p}" class="${p === draftFilter ? 'on' : ''}">${p}</button>`).join('')}</div>
        <div class="grid">${pool.slice(0, 120).map((m) => monCard(m, m.dex === selected ? 'sel' : '')).join('')}</div>
        <div class="od-pickbar ${sel ? '' : 'idle'}">
          ${sel ? `<img src="${spriteUrl(sel.dex)}" alt=""><span><b>${esc(sel.name)}</b> ${sel.pos} · ${sel.ovr} OVR</span>` : `<span>${myTurn ? 'Tap a Pokémon to draft it.' : 'Scout while they pick. Tap a Pokémon to line it up.'}</span>`}
          <button class="btn primary" data-a="pick" ${sel && myTurn ? '' : 'disabled'}>${myTurn ? 'Draft' : 'Wait'}</button>
        </div>
        <p class="net-banner" role="status" hidden></p>
      </div>`;
    root.querySelector('[data-a="leave"]')!.addEventListener('click', () => {
      if (confirmLeave()) leave('You left the draft.');
    });
    root.querySelectorAll<HTMLButtonElement>('[data-f]').forEach((b) => b.addEventListener('click', () => { draftFilter = b.dataset.f!; draft(); }));
    root.querySelector('.grid')!.addEventListener('click', (e) => {
      const c = (e.target as HTMLElement).closest<HTMLElement>('.mon-card');
      if (!c) return;
      selected = Number(c.dataset.dex);
      audio.blip();
      draft();
    });
    root.querySelector('[data-a="pick"]')!.addEventListener('click', () => {
      if (selected === null || !myTurn) return;
      send({ t: 'pick', dex: selected });
      audio.blip(true);
      selected = null;
    });
    const clock = root.querySelector<HTMLElement>('[data-k="clock"]')!;
    const tickClock = () => {
      const s = Math.max(0, Math.ceil((d.deadline - Date.now()) / 1000));
      clock.textContent = `0:${String(s).padStart(2, '0')}`;
      clock.classList.toggle('low', myTurn && s <= 5);
    };
    window.clearInterval(draftTimer);
    tickClock();
    draftTimer = window.setInterval(tickClock, 250);
    presenceBanner();
  }

  const confirmLeave = () => window.confirm('Leaving forfeits the battle and your entry. Leave anyway?');

  // ------------------------------------------------------------ the pull

  function buying() {
    window.clearInterval(draftTimer);
    root.className = 'screen-quick';
    const t = PACK_TIERS[battle.tier];
    root.innerHTML = `
      <div class="quick">
        <section class="card next battle-next room" style="--tc:${t.color}">
          <p class="eyebrow">Pack Battle · Draft complete</p>
          <div class="stake">${packSvg(battle.tier, 96, 'float')}</div>
          <p class="waiting big"><i class="ball-spin" aria-hidden="true"></i>Buying your ${esc(t.ccName)} from Collector Crypt…</p>
          <p class="note center">Both entries pay for one pull, opened now so you both see the card before tip-off. Collector Crypt's VRF picks the card, and the same VRF result seeds this game.</p>
        </section>
        <p class="net-banner" role="status" hidden></p>
      </div>`;
    presenceBanner();
  }

  function reveal(p: PullView, startsAt: number) {
    window.clearInterval(draftTimer);
    window.clearInterval(revealTimer);
    root.className = 'screen-quick';
    const t = PACK_TIERS[battle.tier];
    root.innerHTML = `
      <div class="quick">
        <section class="card next battle-next room reveal" style="--tc:${t.color}">
          <p class="eyebrow">Pack Battle · ${esc(t.ccName)}</p>
          <h2>You're playing for</h2>
          ${cardHtml(p)}
          <p class="tip-clock" data-k="tip">Tip-off in 0:08</p>
          <p class="fair">Picked by <b>Collector Crypt's VRF</b> when the pull was paid, and recorded on Solana (memo <b>${esc(p.memo)}</b>). <a href="${esc(p.verifyUrl)}" target="_blank" rel="noopener">See how this card was picked</a> · <a href="${esc(p.vrfUrl)}" target="_blank" rel="noopener">VRF record</a>. The game's random rolls come from the same VRF result, mixed with the seed the server committed to (${esc(battle.commit.slice(0, 12))}…) and a seed from each of you, so nobody could choose them. Winner takes the card.</p>
        </section>
        <p class="net-banner" role="status" hidden></p>
      </div>`;
    const clock = root.querySelector<HTMLElement>('[data-k="tip"]')!;
    const tick = () => {
      const s = Math.max(0, Math.ceil((startsAt - Date.now()) / 1000));
      clock.textContent = s ? `Tip-off in 0:${String(s).padStart(2, '0')}` : 'Tip-off!';
    };
    tick();
    revealTimer = window.setInterval(tick, 250);
    audio.blip(true);
    presenceBanner();
  }

  // ------------------------------------------------------------ game

  function mountGame(g: Game) {
    window.clearInterval(draftTimer);
    window.clearInterval(revealTimer);
    view?.stop();
    root.className = 'screen-game';
    audio.unlock();
    g.cfg.court ??= courtFor(g.teams[0]);
    view = playOnline(root, g, client!, audio, send, () => {
      if (confirmLeave()) leave(`You left the game, so ${them?.teamName ?? 'your opponent'} get the pull.`);
    });
    void preload([...g.teams[0].roster, ...g.teams[1].roster]).then(() => client?.ready());
    presenceBanner();
  }

  // ------------------------------------------------------------ result

  function final(b: BattleView) {
    closed = true;
    window.clearInterval(draftTimer);
    window.clearInterval(revealTimer);
    window.clearInterval(presenceTimer);
    view?.stop();
    ws?.close();
    const t = PACK_TIERS[b.tier];
    const won = b.winner === side;
    const g = client?.game;
    const card = b.pull ?? pull;
    if (b.state === 'void') {
      root.className = 'screen-quick';
      root.innerHTML = `
        <div class="quick"><section class="card next room" style="--tc:${t.color}">
          <p class="eyebrow">Pack Battle · called off</p>
          <h2>No contest</h2>
          <p class="note center">The battle couldn't be played, so you both got your entry back.</p>
          <div class="actions center"><button class="btn primary big" data-a="lobby">Back to battles</button></div>
        </section></div>`;
      root.querySelector('[data-a="lobby"]')!.addEventListener('click', () => act.lobby());
      return;
    }
    const prize = card ? `the ${esc(card.name)}` : `the ${t.short} pack`;
    const outcome = won
      ? `<section class="pack-won" style="--tc:${t.color}">
          <div class="pack-rip">${card ? cardHtml(card) : packSvg(b.tier, 116)}<i class="burst" aria-hidden="true"></i></div>
          <p>YOU WON ${prize.toUpperCase()}${b.forfeit ? ' BY FORFEIT' : ''}!</p>
          <p class="pw-2">${card ? "It's being sent to your wallet now." : `Your ${esc(t.ccName)} is being bought and sent to your wallet.`}</p>
        </section>`
      : `<section class="pack-won lost" style="--tc:${t.color}">
          <div class="pack-gone">${card ? cardHtml(card, 'small') : packSvg(b.tier, 84)}</div>
          <p>${esc((them?.teamName ?? 'They').toUpperCase())} TOOK ${prize.toUpperCase()}${b.forfeit ? ' BY FORFEIT' : ''}.</p>
          <p class="pw-2">Run it back: there are more battles in the lobby.</p>
        </section>`;
    const proof = `<p class="note center proof-link"><a href="${esc(api.proofUrl(b.id))}" target="_blank" rel="noopener">Check this result</a>: every seed, the Collector Crypt VRF record and every input, replayable with <code>bun verify.ts ${esc(b.id)}</code>.${card ? ` <a href="${esc(card.verifyUrl)}" target="_blank" rel="noopener">How the card was picked</a>.` : ''}</p>`;
    const buttons = won
      ? [{ id: 'prizes', label: 'See your prizes', kind: 'primary' as const }, { id: 'lobby', label: 'Back to battles' }]
      : [{ id: 'lobby', label: 'Find another battle', kind: 'primary' as const }, { id: 'menu', label: 'Main menu', kind: 'ghost' as const }];
    const onAction = (a: string) => (a === 'prizes' ? act.prizes() : a === 'menu' ? act.menu() : act.lobby());
    if (g && g.players.length) {
      root.className = 'screen-results';
      window.scrollTo(0, 0);
      resultsScreen(root, g, { tag: `Pack Battle · ${t.label}`, headline: won ? 'You win the pack!' : `${them?.teamName ?? 'They'} take the pack`, extraHtml: outcome + proof, buttons, onAction });
    } else {
      root.className = 'screen-results';
      root.innerHTML = `<div class="results"><p class="final-tag">Pack Battle · ${esc(t.label)} · Forfeit</p><h2>${won ? 'You win the pack!' : 'Forfeit'}</h2>${outcome}
        <div class="actions center">${buttons.map((x) => `<button class="btn ${x.kind ?? ''}" data-a="${x.id}">${esc(x.label)}</button>`).join('')}</div></div>`;
      root.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((x) => x.addEventListener('click', () => onAction(x.dataset.a!)));
    }
  }

  // ------------------------------------------------------------ banners

  function banner(text: string) {
    const el = root.querySelector<HTMLElement>('.net-banner');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  function presenceBanner() {
    const other = (1 - side) as 0 | 1;
    if (!presence.connected[other] && presence.forfeitAt) {
      const s = Math.max(0, Math.ceil((presence.forfeitAt - Date.now()) / 1000));
      banner(`${them?.teamName ?? 'Your opponent'} disconnected. The game is paused; they forfeit in ${s}s if they don't come back.`);
    } else banner('');
  }
  const presenceTimer = window.setInterval(() => { if (!closed && presence.forfeitAt) presenceBanner(); }, 1000);

  waiting();
  connect();
}

/** The game canvas for an online match: renders the local lockstep copy and sends this player's input. */
function playOnline(root: HTMLElement, g: Game, client: LockstepClient, audio: Audio, send: (m: object) => void, onQuit: () => void) {
  root.innerHTML = `
    <div class="game">
      <div class="stage"><canvas class="court" aria-label="Basketball court"></canvas></div>
      <button class="icon-btn pause-btn" aria-label="Menu">II</button>
      <div class="pause-menu" hidden>
        <div class="panel">
          <h2>ONLINE GAME</h2>
          <p class="note center">The game keeps running while this menu is open.</p>
          <div class="pause-actions">
            <button class="btn primary" data-a="resume">Back to the game</button>
            <button class="btn" data-a="mute"></button>
            <button class="btn ghost" data-a="quit">Forfeit and quit</button>
          </div>
          ${controlsHtml()}
        </div>
      </div>
      <p class="net-banner" role="status" hidden></p>
    </div>`;
  const gameEl = root.querySelector<HTMLElement>('.game')!;
  const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
  const menu = root.querySelector<HTMLElement>('.pause-menu')!;
  const muteBtn = menu.querySelector<HTMLButtonElement>('[data-a="mute"]')!;
  const renderer = new Renderer(canvas);
  const hud = new Hud(gameEl, g);
  const input = new Input();
  if (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0) {
    input.attachTouch(gameEl);
    gameEl.classList.add('has-touch');
  }
  const setMute = () => (muteBtn.textContent = audio.muted ? 'Sound: off' : 'Sound: on');
  setMute();
  root.querySelector('.pause-btn')!.addEventListener('click', () => (menu.hidden = !menu.hidden));
  menu.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'resume') menu.hidden = true;
    if (a === 'mute') { audio.setMuted(!audio.muted); setMute(); }
    if (a === 'quit') onQuit();
  });
  audio.startCrowd();

  let running = true;
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let sent = '';
  const frame = (now: number) => {
    if (!running) return;
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    // Input: send when it changes, and always for a button press (edges only live for one frame).
    const { intent, pause } = input.read();
    if (pause) menu.hidden = !menu.hidden;
    const w = packInput(intent);
    const key = `${w.mx},${w.my},${w.b}`;
    if (key !== sent || (w.b & (2 | 8 | 16 | 32 | 64))) {
      send({ t: 'in', ...w });
      sent = key;
    }
    // Ticks: play them at real-time pace, catching up when a backlog builds (a hiccup or a tab switch).
    acc = Math.min(acc + dt, TICK * 4);
    let due = Math.floor(acc / TICK);
    acc -= due * TICK;
    if (client.backlog > 8) due += client.backlog - 4;
    client.advance(due);
    const events = g.events.splice(0);
    hud.handle(events);
    renderer.handle(events, g);
    for (const s of g.sfx.splice(0)) audio.play(s);
    const u = g.user;
    input.setContext(!!u && g.ball.owner === u, !!u && u.special >= 1);
    renderer.draw(g, dt);
    hud.update(dt);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return {
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      input.destroy();
      audio.stopCrowd();
    },
  };
}

