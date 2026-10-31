// Browser check for the direct link (not part of the game build): two players in one page, each with a real
// MatchLink over a real WebRTC connection (local candidates only, no TURN), play a full lockstep game. Midway the
// direct link is cut, and the game must carry on over the "Realtime" fallback (here a fake channel) to the same
// final state on both sides. Driven by scripts/rtc-check.mjs.
import '../framed';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { COURTS } from '../data/courts';
import { monByDex } from '../data/pokemon';
import { Game } from '../game/game';
import { emptyIntent, seededRng, type GameConfig, type Intent, type TeamDef } from '../game/types';
import { Lockstep } from '../multiplayer/shared/lockstep';
import { MatchLink } from '../multiplayer/shared/netplay';

const team = (name: string, dexes: number[]): TeamDef => ({ name, abbr: name.slice(0, 3).toUpperCase(), color: '#3b6fd8', color2: '#16224a', human: true, roster: dexes.map(monByDex) });
const config = (): GameConfig => ({ home: team('Pallet Town', [25, 381, 6, 445, 382]), away: team('Indigo Elite', [94, 130, 149, 248, 150]), quarterLen: 6, difficulty: 'pro', court: COURTS['Indigo Elite'], seed: 77 });

function player(seed: number) {
  const rng = seededRng(seed);
  let held = emptyIntent();
  return (): Intent => {
    if (rng() < 0.08) { held = emptyIntent(); held.mx = rng() * 2 - 1; held.my = rng() * 2 - 1; held.turbo = rng() < 0.3; }
    const shoot = rng() < 0.03;
    return { ...held, shoot, shootHeld: shoot, pass: rng() < 0.01, steal: rng() < 0.01 };
  };
}

/** Two fake Realtime channels wired to each other: what one sends, the other's handlers get (after a delay). */
function fakeChannels() {
  const handlers: Record<string, (p: { payload: unknown }) => void>[] = [{}, {}];
  const counts = [0, 0];
  const make = (me: 0 | 1) => ({
    on(_type: string, f: { event: string }, cb: (p: { payload: unknown }) => void) { handlers[me][f.event] = cb; return this; },
    send(m: { event: string; payload: unknown }) {
      counts[me]++;
      const copy = JSON.parse(JSON.stringify(m.payload));
      setTimeout(() => handlers[1 - me][m.event]?.({ payload: copy }), 25 + Math.random() * 30);
      return Promise.resolve('ok');
    },
  }) as unknown as RealtimeChannel;
  return { chans: [make(0), make(1)], counts, handlers };
}

async function run(cutAfterMs: number) {
  const { chans, counts, handlers } = fakeChannels();
  const sb = { removeChannel: () => Promise.resolve('ok') } as unknown as SupabaseClient;
  const links = [new MatchLink(chans[0], sb), new MatchLink(chans[1], sb)];
  links.forEach((l, i) => {
    handlers[i].ls = ({ payload }) => l.deliver(payload);
    handlers[i].rtc = ({ payload }) => l.signal(payload);
  });
  links[1].upgrade(1, [], 'all');
  links[0].upgrade(0, [], 'all');
  const opened = performance.now();
  while (!(links[0].direct && links[1].direct) && performance.now() - opened < 8000) await new Promise((r) => setTimeout(r, 50));
  const connectMs = Math.round(performance.now() - opened);
  const directAtStart = links[0].direct && links[1].direct;

  const games = [new Game(config()), new Game(config())];
  const ls = [new Lockstep(games[0], links[0], { side: 0 }), new Lockstep(games[1], links[1], { side: 1 })];
  links[0].attach(ls[0]);
  links[1].attach(ls[1]);
  const players = [player(1), player(2)];
  const held = [players[0](), players[1]()];
  const start = performance.now();
  let last = start;
  let cut = false;
  let paceOnFallback = 0;
  while ((games[0].phase !== 'final' || games[1].phase !== 'final') && performance.now() - start < 120_000) {
    await new Promise((r) => setTimeout(r, 16));
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    if (!cut && now - start > cutAfterMs) {
      cut = true;
      (links[0] as unknown as { rtc: { close(): void } | null }).rtc?.close(); // the far side sees its channels close too
    }
    for (const s of [0, 1]) if (ls[s].advance(held[s], dt) > 0) held[s] = players[s]();
    if (cut && !links[0].direct && !links[1].direct) paceOnFallback = links[0].pace();
    for (const g of games) { g.events.length = 0; g.sfx.length = 0; }
  }
  return {
    connectMs, directAtStart, finished: games.every((g) => g.phase === 'final'),
    same: ls[0].hash() === ls[1].hash(), score: [...games[0].score], scoreGuest: [...games[1].score],
    sent: [links[0].sent, links[1].sent], realtimeMessages: counts, paceOnFallback,
    stats: ls.map((l) => ({ ...l.stats, problem: l.problem })),
  };
}

Object.assign(window, { rtcCheck: { run } });
