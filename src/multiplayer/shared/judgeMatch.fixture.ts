// A Pack Battle that's really played, for the judge's tests: two clients play a full lockstep game over a lossy
// link, signing every input batch they send, and each packs an upload the way onlineGame.ts does.
import { Game } from '../../game/game';
import type { WireInput } from '../../game/sync';
import { emptyIntent, seededRng, type Intent } from '../../game/types';
import { pack } from './evidence';
import type { DueBattle } from './judgeMatch';
import { Lockstep, MIN_DELAY, type NetMsg } from './lockstep';
import { setupFor } from './netplay';
import type { OnlineMatch } from './onlineMatchService';
import { gameConfigFor, matchKey, signResign, signTicks, type SignedInputs } from './winnerCheck';

function player(seed: number) {
  const rng = seededRng(seed);
  let held = emptyIntent();
  return (): Intent => {
    if (rng() < 0.08) { held = emptyIntent(); held.mx = rng() * 2 - 1; held.my = rng() * 2 - 1; held.turbo = rng() < 0.3; }
    const shoot = rng() < 0.03;
    return { ...held, shoot, shootHeld: shoot, pass: rng() < 0.01, steal: rng() < 0.01 };
  };
}
const expand = (m: Extract<NetMsg, { k: 'in' }>): WireInput[] => m.r.flatMap(([n, mx, my, b]) => Array.from({ length: n }, () => ({ mx, my, b })));

/**
 * A battle row and two players who really play it, signing every input batch they send. `stopAt` stops the game at
 * that tick; `resign` has that side leave there on purpose, sending its signed resignation (both uploads hold it).
 */
export async function playedBattle(seed: number, opts: { stopAt?: number; resign?: 0 | 1 } = {}) {
  const keys = [await matchKey(), await matchKey()];
  const row: DueBattle = {
    match_id: `pack-${seed}`, tier: 'pokemon_25', seed, quarter_len: 12, host: 'host-id', guest: 'guest-id',
    host_key: keys[0].publicKey, guest_key: keys[1].publicKey, host_name: 'Ash', guest_name: 'Misty', uploads: [],
    host_uploaded: true, guest_uploaded: true,
  };
  // Each player builds the game from the match row, the way connect() does.
  const view = (side: 0 | 1): OnlineMatch => ({
    id: row.match_id, queue: 'pack', side, me: side ? { id: row.guest, name: row.guest_name } : { id: row.host, name: row.host_name },
    opponent: side ? { id: row.host, name: row.host_name, mmr: 1000, simulated: false } : { id: row.guest, name: row.guest_name, mmr: 1000, simulated: false },
    game: { seed, quarterLen: 12, rosters: null }, keys: [row.host_key, row.guest_key],
  });
  const setups = [setupFor(view(0)), setupFor(view(1))];
  const games = [new Game(gameConfigFor(setups[0])), new Game(gameConfigFor(setups[1]))];
  const rng = seededRng(seed);
  let now = 0;
  const queue: { at: number; to: 0 | 1; m: NetMsg }[] = [];
  const signed: Promise<SignedInputs>[][] = [[], []];
  const link = (from: 0 | 1) => ({
    send(m: NetMsg) {
      if (m.k === 'in' && m.r.length) signed[from].push(signTicks(keys[from].privateKey, row.match_id, from, m.s, expand(m)));
      if (m.k === 'in' && rng() < 0.1) return;
      queue.push({ at: now + 30 + rng() * 110, to: (1 - from) as 0 | 1, m: JSON.parse(JSON.stringify(m)) });
    },
  });
  const ls = [0, 1].map((s) => new Lockstep(games[s], link(s as 0 | 1), { side: s as 0 | 1, now: () => now }));
  const players = [player(seed + 1), player(seed + 2)];
  const held: Intent[] = [players[0](), players[1]()];
  for (let f = 0; (games[0].phase !== 'final' || games[1].phase !== 'final') && f < 200_000; f++) {
    if (opts.stopAt !== undefined && ls[0].tick >= opts.stopAt) break;
    now += 1000 / 60 + (rng() - 0.5) * 6;
    queue.sort((a, b) => a.at - b.at);
    while (queue.length && queue[0].at <= now) { const q = queue.shift()!; ls[q.to].receive(q.m); }
    for (const s of [0, 1]) {
      if (ls[s].advance(held[s], 1 / 60) > 0) held[s] = players[s]();
      games[s].events.length = 0;
      games[s].sfx.length = 0;
    }
  }
  for (const l of ls) l.maybeSend(true);
  const mine = [await Promise.all(signed[0]), await Promise.all(signed[1])];
  // Each player uploads what it sent and what it received (here: everything the other side signed).
  const resigns = opts.resign === undefined ? [] : [await signResign(keys[opts.resign].privateKey, row.match_id, opts.resign)];
  const upload = (side: 0 | 1) => pack({ setup: setups[side], keys: [row.host_key!, row.guest_key!], inputs: [...mine[side], ...mine[1 - side]], applied: [], lockstep: { emptyTicks: MIN_DELAY }, resigns });
  row.uploads = [await upload(0), await upload(1)];
  return { row, games, keys, mine };
}

/** The host's view of a battle row (what the judge rebuilds the game from). */
export const hostMatch = (row: DueBattle): OnlineMatch => ({
  id: row.match_id, queue: 'pack', side: 0, me: { id: row.host, name: row.host_name },
  opponent: { id: row.guest, name: row.guest_name, mmr: 1000, simulated: false },
  game: { seed: Number(row.seed), quarterLen: row.quarter_len, rosters: null }, keys: [row.host_key, row.guest_key],
});
