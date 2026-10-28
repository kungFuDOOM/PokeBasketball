// Winner check: decide an online match from its inputs, not from what either player claims.
//
// Online play is host-authoritative (the host runs the game; the guest sends input). That's fine for
// Social and Ranked, but before a prize moves we need a result neither side can fake. The engine is
// deterministic (seeded, fixed tick, ENGINE_VERSION), so the game can be replayed from its inputs. What
// has to be trusted is the input log, so every piece of it is signed by the player it belongs to:
//
//   * Each player makes an Ed25519 key for the match and registers the public half before tip-off.
//   * Each player sends its own input as numbered frames (seq 1, 2, 3...), in signed batches
//     (signInputs). Each side keeps every batch it sent and every batch it received.
//   * The host decides which frame of each side applies on each tick, and broadcasts that "applied log"
//     in signed chunks (signApplied): one [hostSeq, guestSeq] pair per tick, 0 = no frame yet.
//     A frame that stays applied on later ticks keeps its stick and held buttons, but its button presses
//     only count on the tick it first applied (inputForTick), exactly as a live game feels.
//
// After the game either player (or both) submits everything it holds, and judge() replays it. The host
// can't invent the guest's input (it would need the guest's key), can't rewrite its own afterwards
// without the guest holding the original (two different signed versions are proof, and the cheater
// forfeits), and a player who goes silent is judged on the other's evidence. A log that stops early is
// "incomplete" and the caller applies its forfeit rule.
//
// Shared by the browser (to sign and keep evidence) and the server (to judge); nothing here trusts the
// caller.

import { monByDex } from '../../data/pokemon';
import { Game } from '../../game/game';
import { stateHash, stepGame, type WireInput } from '../../game/sync';
import { ENGINE_VERSION, type GameConfig, type TeamDef } from '../../game/types';

/** Online matches always use this difficulty: with two humans, no CPU boosts or assists apply. */
export const ONLINE_DIFFICULTY = 'allstar' as const;

/** Hard stop, whatever happens in overtime: 45 minutes of game time. */
export const MAX_TICKS = 60 * 60 * 45;

/** Button bits that are presses (count once), not holds: shoot, pass, steal, special, swap. */
export const PRESS_BITS = 2 | 8 | 16 | 32 | 64;

export interface MatchTeam {
  name: string;
  abbr: string;
  color: string;
  color2: string;
  /** Five Pokédex numbers. */
  roster: number[];
}

/** Everything both copies of the game are built from, fixed before tip-off. */
export interface MatchSetup {
  matchId: string;
  engineVersion: number;
  seed: number;
  quarterLen: number;
  home: MatchTeam;
  away: MatchTeam;
}

/** Each side's registered public key (raw Ed25519, hex). Index 0 = host (home), 1 = guest (away). */
export type MatchKeys = [string, string];

/** A side's frames `from`, from+1, … as [mx, my, buttons], signed by that side. */
export interface SignedInputs {
  side: 0 | 1;
  from: number;
  frames: [number, number, number][];
  sig: string;
}

/** Ticks `from`, from+1, … : which [host seq, guest seq] applied, signed by the host. */
export interface SignedApplied {
  from: number;
  entries: [number, number][];
  sig: string;
}

/** What players submit: everything signed they sent or received. Duplicates are fine. */
export interface Evidence {
  setup: MatchSetup;
  keys: MatchKeys;
  inputs: SignedInputs[];
  /** Host-authoritative sync only: the host's signed applied log. */
  applied: SignedApplied[];
  /**
   * Lockstep sync (src/multiplayer/shared/lockstep.ts): tick t always uses each side's frame for tick t,
   * so there is no applied log. Frames are numbered by tick (seq = tick + 1, see signTicks), and the first
   * `emptyTicks` ticks (lockstep's MIN_DELAY) carry no input from either side.
   */
  lockstep?: { emptyTicks: number };
}

export type VerdictStatus =
  /** Played to the final buzzer: `winner` is decided by the replay. */
  | 'final'
  /** The evidence stops before the buzzer (someone left or went silent); `score` is where it stopped. */
  | 'incomplete'
  /** A side signed two different versions of the same frame or tick: they lose. */
  | 'forfeit'
  /** The evidence can't be judged (wrong engine, broken log, bad keys); nothing should move. */
  | 'invalid';

export interface Verdict {
  status: VerdictStatus;
  winner: 0 | 1 | null;
  score: [number, number];
  ticks: number;
  /** stateHash after the last replayed tick. */
  hash: number;
  /** The side caught equivocating, for 'forfeit'. */
  cheater?: 0 | 1;
  /** Why, in plain words; also lists signed items that were ignored. */
  notes: string[];
}

// ---------------------------------------------------------------- the game both sides build

const teamDef = (t: MatchTeam): TeamDef => ({ name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, roster: t.roster.map(monByDex), human: true });

/** The GameConfig for a match. Host, guest and judge must all build the game from this. */
export function gameConfigFor(s: MatchSetup): GameConfig {
  return {
    home: teamDef(s.home), away: teamDef(s.away), quarterLen: s.quarterLen, difficulty: ONLINE_DIFFICULTY,
    autoSwitch: true, seed: s.seed, engineVersion: s.engineVersion,
  };
}

/**
 * The input a side's frame contributes on a tick. `seq` is the frame applied now, `prev` the one applied
 * on the tick before: a frame that's still applied keeps its stick and held buttons, but not its presses.
 */
export function inputForTick(frames: readonly WireInput[], seq: number, prev: number): WireInput | null {
  if (seq <= 0) return null;
  const f = frames[seq - 1];
  if (!f) return null;
  return seq === prev ? { mx: f.mx, my: f.my, b: f.b & ~PRESS_BITS } : f;
}

// ---------------------------------------------------------------- signatures

const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => {
  if (!/^(?:[0-9a-f]{2})*$/i.test(h)) throw new Error('not hex');
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};

const inputsMessage = (matchId: string, side: 0 | 1, from: number, frames: [number, number, number][]) =>
  enc.encode(`pokejam-inputs-v1|${matchId}|${side}|${from}|${JSON.stringify(frames)}`);
const appliedMessage = (matchId: string, from: number, entries: [number, number][]) =>
  enc.encode(`pokejam-applied-v1|${matchId}|${from}|${JSON.stringify(entries)}`);

/** A fresh Ed25519 key for one match. Register `publicKey` (hex) before tip-off; never reuse it. */
export async function matchKey(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const k = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { privateKey: k.privateKey, publicKey: hex(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))) };
}

const sign = async (key: CryptoKey, msg: Uint8Array<ArrayBuffer>) => hex(new Uint8Array(await crypto.subtle.sign('Ed25519', key, msg)));

async function verify(publicKey: string, msg: Uint8Array<ArrayBuffer>, sig: string): Promise<boolean> {
  try {
    const raw = unhex(publicKey);
    const s = unhex(sig);
    if (raw.length !== 32 || s.length !== 64) return false;
    const k = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', k, s, msg);
  } catch {
    return false;
  }
}

const tripleOf = (w: WireInput): [number, number, number] => [w.mx, w.my, w.b | 0];

/** Sign a batch of this side's own frames, starting at seq `from` (frames are packInput results). */
export async function signInputs(key: CryptoKey, matchId: string, side: 0 | 1, from: number, frames: WireInput[]): Promise<SignedInputs> {
  const triples = frames.map(tripleOf);
  return { side, from, frames: triples, sig: await sign(key, inputsMessage(matchId, side, from, triples)) };
}

/**
 * Lockstep: sign this side's inputs for ticks `fromTick`, fromTick+1, … (the `s` and expanded runs of an
 * 'in' message). Frames are numbered by tick, so this is signInputs at seq fromTick + 1.
 */
export function signTicks(key: CryptoKey, matchId: string, side: 0 | 1, fromTick: number, inputs: WireInput[]): Promise<SignedInputs> {
  return signInputs(key, matchId, side, fromTick + 1, inputs);
}

/** Host only: sign which frames applied on ticks `from`, from+1, … */
export async function signApplied(key: CryptoKey, matchId: string, from: number, entries: [number, number][]): Promise<SignedApplied> {
  const e = entries.map(([h, g]) => [h | 0, g | 0] as [number, number]);
  return { from, entries: e, sig: await sign(key, appliedMessage(matchId, from, e)) };
}

// ---------------------------------------------------------------- replay

/** Play a game from its setup and per-tick inputs. Stops at the final buzzer or the end of the log. */
export function replay(setup: MatchSetup, ticks: Iterable<[WireInput | null, WireInput | null]>) {
  const g = new Game(gameConfigFor(setup));
  let n = 0;
  for (const ins of ticks) {
    if (g.phase === 'final' || n >= MAX_TICKS) break;
    stepGame(g, ins);
    g.events.length = 0;
    g.sfx.length = 0;
    n++;
  }
  return { game: g, ticks: n, score: [g.score[0], g.score[1]] as [number, number], final: g.phase === 'final', hash: stateHash(g) };
}

// ---------------------------------------------------------------- judging

const isInt = (n: unknown): n is number => Number.isSafeInteger(n);
const okFrame = (f: unknown): f is [number, number, number] =>
  Array.isArray(f) && f.length === 3 && f.every((x) => typeof x === 'number' && Number.isFinite(x));

function validSetup(s: MatchSetup): string | null {
  if (!s || typeof s.matchId !== 'string' || !s.matchId) return 'setup has no match id';
  if (s.engineVersion !== ENGINE_VERSION) return `recorded on engine v${s.engineVersion}, this judge runs engine v${ENGINE_VERSION}`;
  if (!isInt(s.seed) || s.seed < 0) return 'setup seed is not a whole number';
  if (!isInt(s.quarterLen) || s.quarterLen <= 0 || s.quarterLen > 600) return 'setup quarter length is out of range';
  for (const t of [s.home, s.away]) {
    if (!t || !Array.isArray(t.roster) || t.roster.length !== 5) return 'each team needs five Pokémon';
    try { t.roster.forEach(monByDex); } catch { return `unknown Pokémon in ${t.name}`; }
  }
  if (new Set([...s.home.roster, ...s.away.roster]).size !== 10) return 'a Pokémon is on both teams (or twice on one)';
  return null;
}

/**
 * Lay signed items into slots (frame or tick index), checking each signature. Two different signed
 * versions of one slot are equivocation: returns the slot so the caller can rule against the signer.
 */
async function collect<T, V>(
  items: T[], ok: (it: T) => boolean, check: (it: T) => Promise<boolean>, start: (it: T) => number, values: (it: T) => V[],
  same: (a: V, b: V) => boolean, notes: string[], label: string,
): Promise<{ slots: V[]; clash: number | null }> {
  const slots: V[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const key = JSON.stringify(it);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!ok(it) || !(await check(it))) { notes.push(`ignored a ${label} with a bad shape or signature`); continue; }
    const from = start(it);
    const vals = values(it);
    for (let i = 0; i < vals.length; i++) {
      const at = from - 1 + i;
      if (at >= MAX_TICKS) break;
      if (slots[at] === undefined) slots[at] = vals[i];
      else if (!same(slots[at], vals[i])) return { slots, clash: at + 1 };
    }
  }
  return { slots, clash: null };
}

/** Judge a match from all the evidence the players submitted. */
export async function judge(ev: Evidence): Promise<Verdict> {
  const notes: string[] = [];
  const out = (status: VerdictStatus, extra: Partial<Verdict> = {}): Verdict =>
    ({ status, winner: null, score: [0, 0], ticks: 0, hash: 0, notes, ...extra });

  const bad = validSetup(ev?.setup);
  if (bad) return out('invalid', { notes: [bad] });
  const { setup } = ev;
  if (!Array.isArray(ev.keys) || ev.keys.length !== 2 || ev.keys[0] === ev.keys[1]) return out('invalid', { notes: ['the two players need two different keys'] });

  // Each side's frames, as signed by that side.
  const frames: WireInput[][] = [[], []];
  for (const side of [0, 1] as const) {
    const mine = (ev.inputs ?? []).filter((b) => b?.side === side);
    const { slots, clash } = await collect(
      mine,
      (b) => isInt(b.from) && b.from >= 1 && Array.isArray(b.frames) && b.frames.every(okFrame) && typeof b.sig === 'string',
      (b) => verify(ev.keys[side], inputsMessage(setup.matchId, side, b.from, b.frames), b.sig),
      (b) => b.from, (b) => b.frames,
      (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2], notes, `${side ? 'guest' : 'host'} input batch`,
    );
    if (clash !== null) return out('forfeit', { cheater: side, winner: (1 - side) as 0 | 1, notes: [...notes, `${side ? 'guest' : 'host'} signed two different versions of frame ${clash}`] });
    frames[side] = slots.map((f) => ({ mx: f[0], my: f[1], b: f[2] }));
  }

  // Lockstep: the applied log is implied. Tick t uses frame t from each side, after the empty warm-up.
  if (ev.lockstep) {
    const empty = ev.lockstep.emptyTicks;
    if (!isInt(empty) || empty < 0 || empty > 60) return out('invalid', { notes: [...notes, 'lockstep warm-up must be 0 to 60 ticks'] });
    if ((ev.applied ?? []).length) notes.push('ignored the applied log: lockstep has none');
    const ticks: [WireInput | null, WireInput | null][] = [];
    for (let t = 0; t < MAX_TICKS; t++) {
      if (t < empty) { ticks.push([null, null]); continue; }
      const h = frames[0][t];
      const g = frames[1][t];
      if (!h || !g) break; // nobody holds both inputs for this tick: the game couldn't have run past it
      ticks.push([h, g]);
    }
    return settle(replay(setup, ticks), notes, out);
  }

  // The host's applied log.
  const { slots: applied, clash } = await collect(
    ev.applied ?? [],
    (c) => isInt(c.from) && c.from >= 1 && Array.isArray(c.entries) && typeof c.sig === 'string'
      && c.entries.every((e) => Array.isArray(e) && e.length === 2 && isInt(e[0]) && isInt(e[1]) && e[0] >= 0 && e[1] >= 0),
    (c) => verify(ev.keys[0], appliedMessage(setup.matchId, c.from, c.entries), c.sig),
    (c) => c.from, (c) => c.entries,
    (a, b) => a[0] === b[0] && a[1] === b[1], notes, 'applied-log chunk',
  );
  if (clash !== null) return out('forfeit', { cheater: 0, winner: 1, notes: [...notes, `host signed two different applied logs for tick ${clash}`] });

  // Replay up to the first gap in the log, checking every referenced frame really exists in order.
  const ticks: [WireInput | null, WireInput | null][] = [];
  const prev: [number, number] = [0, 0];
  for (let t = 0; t < applied.length && applied[t] !== undefined; t++) {
    const pair = applied[t];
    for (const side of [0, 1] as const) {
      if (pair[side] < prev[side]) return out('invalid', { notes: [...notes, `tick ${t + 1} goes back to an earlier ${side ? 'guest' : 'host'} frame`] });
      if (pair[side] > 0 && !frames[side][pair[side] - 1]) {
        return out('invalid', { notes: [...notes, `tick ${t + 1} uses ${side ? 'guest' : 'host'} frame ${pair[side]}, which nobody submitted signed`] });
      }
    }
    ticks.push([inputForTick(frames[0], pair[0], prev[0]), inputForTick(frames[1], pair[1], prev[1])]);
    prev[0] = pair[0];
    prev[1] = pair[1];
  }

  return settle(replay(setup, ticks), notes, out);
}

/** Turn a replay into a verdict: final at the buzzer, otherwise incomplete where the evidence ran out. */
function settle(r: ReturnType<typeof replay>, notes: string[], out: (s: VerdictStatus, extra?: Partial<Verdict>) => Verdict): Verdict {
  const leader = r.score[0] === r.score[1] ? null : r.score[0] > r.score[1] ? 0 : 1;
  const base = { winner: leader, score: r.score, ticks: r.ticks, hash: r.hash } as const;
  if (r.final) return out('final', base);
  if (r.ticks >= MAX_TICKS) return out('incomplete', { ...base, notes: [...notes, 'hit the 45-minute hard stop'] });
  return out('incomplete', { ...base, notes: [...notes, `the inputs stop at tick ${r.ticks}, before the final buzzer`] });
}
