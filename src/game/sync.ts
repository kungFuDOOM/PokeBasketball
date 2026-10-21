// Keeping online games in sync.
//
// Online battles run in lockstep: the server owns the clock, collects both players' inputs, and sends
// every client the same input for every tick. The simulation is deterministic (seeded RNG, fixed step),
// so every copy of the game plays out the same and the server's copy decides the winner.
//
// Floating-point maths (Math.sin, Math.atan2…) can differ in the last bit between browser engines, so a
// copy can drift. stateHash() lets clients compare against the server every so often; snapshot() and
// restore() let the server put a drifted (or reconnecting) client back on the exact authoritative state.

import { emptyIntent, type Intent, type Player, type TeamId } from './types';
import type { Game } from './game';

/** One tick of input for one player, as sent over the wire. */
export interface WireInput {
  mx: number;
  my: number;
  /** Bit flags, see INPUT_BITS. */
  b: number;
}

const BITS = { turbo: 1, shoot: 2, shootHeld: 4, pass: 8, steal: 16, special: 32, swap: 64 } as const;
type Btn = keyof typeof BITS;

/** Stick axes are rounded to 1/100 so the same input means the same thing everywhere. */
const q = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 100) / 100;

export function packInput(i: Intent): WireInput {
  let b = 0;
  for (const k of Object.keys(BITS) as Btn[]) if (i[k]) b |= BITS[k];
  return { mx: q(i.mx), my: q(i.my), b };
}

export function unpackInput(w: WireInput | null | undefined): Intent {
  const i = emptyIntent();
  if (!w) return i;
  i.mx = q(Number(w.mx) || 0);
  i.my = q(Number(w.my) || 0);
  const b = Number(w.b) | 0;
  for (const k of Object.keys(BITS) as Btn[]) i[k] = (b & BITS[k]) !== 0;
  return i;
}

/** Fixed simulation step. Every copy of an online game advances by exactly this much per tick. */
export const TICK = 1 / 60;

/** Advance one tick with both teams' inputs. */
export function stepGame(g: Game, inputs: [WireInput | null, WireInput | null]) {
  g.inputs = [unpackInput(inputs[0]), unpackInput(inputs[1])];
  g.update(TICK);
}

// ---------------------------------------------------------------- hash

/** FNV-1a over the state that decides the game: positions, ball, clocks, score and the RNG position. */
export function stateHash(g: Game): number {
  let h = 0x811c9dc5;
  const add = (n: number) => {
    const s = Number.isFinite(n) ? Math.round(n * 1000) : n > 0 ? 1e12 : -1e12;
    // Mix the 53-bit integer in two halves.
    for (const part of [s | 0, Math.floor(s / 4294967296) | 0]) {
      h ^= part;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  add(g.score[0]); add(g.score[1]); add(g.quarter); add(g.clock); add(g.shotClock); add(g.rng.state);
  const b = g.ball;
  add(b.x); add(b.y); add(b.z); add(b.owner ? b.owner.id : -1);
  for (const p of g.players) { add(p.id); add(p.x); add(p.y); add(p.z); add(p.special); }
  return h >>> 0;
}

// ---------------------------------------------------------------- snapshot / restore

// Fields that come from the config (identical on every copy) or are per-screen, never part of the state.
const SKIP = new Set(['cfg', 'teams', 'diff', 'seed', 'rng', 'vsCpu', 'events', 'sfx', 'viewTeam', 'paused']);

const isPlayer = (v: object): v is Player => 'stats' in v && 'ai' in v && 'mon' in v && 'team' in v;

function encode(v: unknown, top = false): unknown {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return { $f: String(v) };
    return v;
  }
  if (v instanceof Set) return { $set: [...v].map((x) => encode(x)) };
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [encode(k), encode(x)]) };
  if (Array.isArray(v)) return v.map((x) => encode(x, top));
  if (isPlayer(v) && !top) return { $p: v.id };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (top && k === 'mon') continue; // the Pokémon itself comes from the config
    if (typeof x === 'function') continue;
    out[k] = encode(x);
  }
  return out;
}

function decode(v: unknown, byId: Map<number, Player>): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => decode(x, byId));
  const o = v as Record<string, unknown>;
  if ('$p' in o) return byId.get(o.$p as number) ?? null;
  if ('$f' in o) return Number(o.$f);
  if ('$set' in o) return new Set((o.$set as unknown[]).map((x) => decode(x, byId)));
  if ('$map' in o) return new Map((o.$map as [unknown, unknown][]).map(([k, x]) => [decode(k, byId), decode(x, byId)]));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = decode(x, byId);
  return out;
}

export interface Snapshot {
  rng: number;
  game: Record<string, unknown>;
  players: Record<string, unknown>[];
  bench: Record<string, unknown>[];
}

/** The whole simulation state as plain JSON. */
export function snapshot(g: Game): Snapshot {
  const game: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(g)) {
    if (SKIP.has(k) || k === 'players' || k === 'bench' || typeof v === 'function') continue;
    game[k] = encode(v);
  }
  return {
    rng: g.rng.state,
    game,
    players: g.players.map((p) => encode(p, true) as Record<string, unknown>),
    bench: g.bench.map((p) => encode(p, true) as Record<string, unknown>),
  };
}

/** Puts `g` (built from the same config) into the snapshot's exact state. */
export function restore(g: Game, s: Snapshot) {
  const byId = new Map<number, Player>();
  for (const p of [...g.players, ...g.bench]) byId.set(p.id, p);
  const revive = (list: Record<string, unknown>[]) => list.map((enc) => {
    const p = byId.get(enc.id as number);
    if (!p) throw new Error(`snapshot has unknown player ${String(enc.id)}`);
    Object.assign(p, decode(enc, byId));
    return p;
  });
  const players = revive(s.players);
  const bench = revive(s.bench);
  const mutable = g as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(s.game)) mutable[k] = decode(v, byId);
  g.players = players;
  g.bench = bench;
  g.rng.state = s.rng;
  g.events.length = 0;
  g.sfx.length = 0;
}

/** Which team a client controls; the other team's input comes from the server. */
export type Side = TeamId;
