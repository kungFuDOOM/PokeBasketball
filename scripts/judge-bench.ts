// Benchmark of the winner check (anti-cheat PR 5): how much CPU does judging one full match cost? Not part of
// `vitest run` (only its smoke test is: supabase/functions/_shared/judge/bench.test.ts). Results: docs/multiplayer.md.
//
// 1. Make fixtures once. Two real Lockstep clients play over a lossy link, sign with the real EvidenceLog and pack():
//      npx esbuild scripts/judge-bench.ts --bundle --platform=node --format=esm --outfile=/tmp/judge-bench.mjs
//      node /tmp/judge-bench.mjs gen /tmp/judge-fixtures 5
// 2. Judge each fixture in a fresh process, because simulating warms the JIT and an Edge worker may start cold:
//      node /tmp/judge-bench.mjs judge /tmp/judge-fixtures/honest-0.json >> /tmp/node.jsonl
//      npx deno@2.5.4 run --no-prompt --config supabase/functions/pokejam-judge/deno.json \
//        --allow-read --allow-env --allow-sys scripts/judge-bench.ts judge /tmp/judge-fixtures/honest-0.json >> /tmp/deno.jsonl
// 3. node /tmp/judge-bench.mjs summary /tmp/node.jsonl /tmp/deno.jsonl
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import type { WireInput } from '../src/game/sync';
import type { Intent } from '../src/game/types';
import type { NetMsg } from '../src/multiplayer/shared/lockstep';
import type { Evidence, MatchKeys, MatchSetup, SignedInputs } from '../src/multiplayer/shared/winnerCheck';

/** Largest upload the judge reads (MAX_UPLOAD_CHARS in _shared/judge/handler.ts). */
const MAX_UPLOAD_CHARS = 4_000_000;

export interface Fixture {
  name: string;
  setup: MatchSetup;
  keys: MatchKeys;
  /** pack() strings, as stored in pokejam_match_evidence. */
  uploads: string[];
  ticks: number;
  score: [number, number];
}

export const benchSetup = (seed: number, quarterLen: number): MatchSetup => ({
  matchId: `bench-${seed}`, engineVersion: 0, seed, quarterLen,
  home: { name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', roster: [25, 381, 6, 445, 382] },
  away: { name: 'Indigo Elite', abbr: 'IND', color: '#e3350d', color2: '#3d0a03', roster: [94, 130, 149, 248, 150] },
});

/** Two real clients play one match over a jittery, lossy link. Returns both real uploads and the signing key of the host. */
export async function playMatch(seed: number, quarterLen = 120, drop = 0.05) {
  const [{ Game }, { ENGINE_VERSION, emptyIntent, seededRng }, { Lockstep }, { gameConfigFor, matchKey }, { EvidenceLog, pack }] = await Promise.all([
    import('../src/game/game'), import('../src/game/types'), import('../src/multiplayer/shared/lockstep'),
    import('../src/multiplayer/shared/winnerCheck'), import('../src/multiplayer/shared/evidence'),
  ]);
  const setup = { ...benchSetup(seed, quarterLen), engineVersion: ENGINE_VERSION };
  const pair = [await matchKey(), await matchKey()];
  const keys: MatchKeys = [pair[0].publicKey, pair[1].publicKey];
  const logs = [new EvidenceLog(pair[0].privateKey, setup.matchId, 0), new EvidenceLog(pair[1].privateKey, setup.matchId, 1)];
  const rng = seededRng(seed);
  let now = 0;
  const queue: { at: number; to: 0 | 1; m: NetMsg }[] = [];
  const signing: Promise<unknown>[] = [];
  const link = (from: 0 | 1) => ({
    send(m: NetMsg) {
      if (m.k !== 'in') { queue.push({ at: now + 30 + rng() * 110, to: (1 - from) as 0 | 1, m: JSON.parse(JSON.stringify(m)) }); return; }
      const lost = rng() < drop;
      const at = now + 30 + rng() * 110;
      signing.push(logs[from].sign(m).then((signed) => { if (!lost) queue.push({ at, to: (1 - from) as 0 | 1, m: JSON.parse(JSON.stringify(signed)) }); }));
    },
  });
  const games = [new Game(gameConfigFor(setup)), new Game(gameConfigFor(setup))];
  const ls = [0, 1].map((s) => new Lockstep(games[s], link(s as 0 | 1), { side: s as 0 | 1, now: () => now }));
  const player = (pseed: number) => {
    const r = seededRng(pseed);
    let held = emptyIntent();
    return (): Intent => {
      if (r() < 0.08) { held = emptyIntent(); held.mx = r() * 2 - 1; held.my = r() * 2 - 1; held.turbo = r() < 0.3; }
      const shoot = r() < 0.03;
      return { ...held, shoot, shootHeld: shoot, pass: r() < 0.01, steal: r() < 0.01 };
    };
  };
  const players = [player(seed + 1), player(seed + 2)];
  const held: Intent[] = [players[0](), players[1]()];
  for (let f = 0; (games[0].phase !== 'final' || games[1].phase !== 'final') && f < 400_000; f++) {
    now += 1000 / 60 + (rng() - 0.5) * 6;
    if (signing.length) await Promise.all(signing.splice(0));
    queue.sort((a, b) => a.at - b.at);
    while (queue.length && queue[0].at <= now) {
      const q = queue.shift()!;
      logs[q.to].received(q.m);
      ls[q.to].receive(q.m);
    }
    for (const s of [0, 1]) {
      if (ls[s].advance(held[s], 1 / 60) > 0) held[s] = players[s]();
      games[s].events.length = 0;
      games[s].sfx.length = 0;
    }
  }
  if (games[0].phase !== 'final' || games[1].phase !== 'final') throw new Error(`match ${seed} never finished`);
  // The goodbye flush: anything signed past the last tick, then deliver what's still in flight.
  for (const l of ls) l.maybeSend(true);
  await Promise.all(signing.splice(0));
  for (const q of queue) logs[q.to].received(q.m);
  const uploads = await Promise.all(logs.map((log) => pack(log.evidence(setup, keys))));
  const fixture: Fixture = { name: `honest-${seed}`, setup, keys, uploads, ticks: ls[0].tick, score: [games[0].score[0], games[0].score[1]] };
  return { fixture, hostKey: pair[0].privateKey, hostLog: logs[0] };
}

/**
 * The most expensive upload a player can make within the judge's size cap: every frame they own in its own signed
 * batch, each one a separate signature check. The other player's honest upload still covers the rest of the match, so
 * the full replay runs as well.
 */
export async function hostileFixture(played: Awaited<ReturnType<typeof playMatch>>): Promise<Fixture> {
  const { fixture, hostKey, hostLog } = played;
  const { signInputs } = await import('../src/multiplayer/shared/winnerCheck');
  const { pack } = await import('../src/multiplayer/shared/evidence');
  const frames = new Map<number, [number, number, number]>();
  for (const b of hostLog.mine) b.frames.forEach((f, i) => frames.set(b.from + i, f));
  const singles: SignedInputs[] = await Promise.all([...frames].sort((a, b) => a[0] - b[0]).map(([seq, [mx, my, b]]) => signInputs(hostKey, fixture.setup.matchId, 0, seq, [{ mx, my, b }])));
  const packed = (list: SignedInputs[]) => pack({ setup: fixture.setup, keys: fixture.keys, inputs: list, applied: [] });
  let upload = await packed(singles);
  let batches = singles.length;
  while (upload.length > MAX_UPLOAD_CHARS) {
    batches = Math.floor((batches * MAX_UPLOAD_CHARS * 0.98) / upload.length);
    upload = await packed(singles.slice(0, batches));
  }
  return { ...fixture, name: fixture.name.replace('honest', 'hostile'), uploads: [upload, fixture.uploads[1]] };
}

export interface Measured {
  runtime: string;
  name: string;
  ticks: number;
  uploadChars: number[];
  batches: number;
  status: string;
  loadMs: number;
  unpackMs: number;
  signaturesMs: number;
  replayMs: number;
  /** unpack + signatures + replay. */
  totalMs: number;
  /** All threads of the process, including GC and crypto workers: an upper bound on what a CPU limit would count. */
  cpuMs: number;
  /** The second judge() of the same evidence in this process, once the JIT has warmed up. */
  warmJudgeMs: number;
  /** Process memory before any judging (the runtime and the fixture file) and right after the replay. */
  rssStartMb: number;
  rssMb: number;
  /** JS heap plus external buffers right after the replay: the part of memory the judging itself can grow. */
  heapMb: number;
}

/** Judge a fixture and time each phase. The phases are separate so each one runs cold in a fresh process. */
export async function measure(fx: Fixture, runtime = 'unknown'): Promise<Measured> {
  const rssStartMb = process.memoryUsage().rss / 1e6;
  const t0 = performance.now();
  const [{ mergeEvidence, unpack }, { judge, replay }] = await Promise.all([import('../src/multiplayer/shared/evidence'), import('../src/multiplayer/shared/winnerCheck')]);
  const loadMs = performance.now() - t0;
  const cpu0 = process.cpuUsage();

  const t1 = performance.now();
  const evs: Evidence[] = await Promise.all(fx.uploads.map((u) => unpack(u)));
  const t2 = performance.now();
  const merged = mergeEvidence(evs[0], evs[1], fx.keys, fx.setup);
  // With no warm-up, tick 0 has no frames, so judge() checks every signature and then replays nothing.
  const sigs = await judge({ ...merged, lockstep: { emptyTicks: 0 } });
  const t3 = performance.now();
  if (sigs.notes.some((n) => n.startsWith('ignored'))) throw new Error(`bad signatures in ${fx.name}: ${sigs.notes[0]}`);

  const slots: (WireInput | undefined)[][] = [[], []];
  for (const b of merged.inputs) b.frames.forEach((f, i) => { slots[b.side][b.from - 1 + i] = { mx: f[0], my: f[1], b: f[2] }; });
  const ticks: [WireInput | null, WireInput | null][] = [];
  for (let t = 0; ; t++) {
    if (t < merged.lockstep!.emptyTicks) { ticks.push([null, null]); continue; }
    const [h, g] = [slots[0][t], slots[1][t]];
    if (!h || !g) break;
    ticks.push([h, g]);
  }
  const t4 = performance.now();
  const r = replay(fx.setup, ticks);
  const t5 = performance.now();
  const cpu = process.cpuUsage(cpu0);
  const mem = process.memoryUsage();

  // The whole thing, as the Edge Function calls it. It must agree with what both clients saw.
  const t6 = performance.now();
  const v = await judge(merged);
  const warmJudgeMs = performance.now() - t6;
  if (v.status !== 'final' || v.score[0] !== fx.score[0] || v.score[1] !== fx.score[1] || r.score[0] !== fx.score[0] || r.score[1] !== fx.score[1]) {
    throw new Error(`${fx.name}: judged ${v.status} ${v.score} (${v.notes.join('; ')}), replayed ${r.score}, played ${fx.score}`);
  }
  const unpackMs = t2 - t1;
  const signaturesMs = t3 - t2;
  const replayMs = t5 - t4;
  return {
    runtime, name: fx.name, ticks: v.ticks, uploadChars: fx.uploads.map((u) => u.length), batches: merged.inputs.length, status: v.status,
    loadMs, unpackMs, signaturesMs, replayMs, totalMs: unpackMs + signaturesMs + replayMs, cpuMs: (cpu.user + cpu.system) / 1000, warmJudgeMs,
    rssStartMb, rssMb: mem.rss / 1e6, heapMb: (mem.heapUsed + mem.external) / 1e6,
  };
}

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** A markdown table of p50 / p95 per runtime and scenario. */
export function summarize(rows: Measured[]): string {
  const lines = ['| runtime | scenario | runs | ticks | upload KB | batches | unpack ms | signatures ms | replay ms | total ms | process CPU ms | warm judge ms | RSS start MB | RSS MB | heap+external MB |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  const groups = new Map<string, Measured[]>();
  for (const r of rows) {
    const k = `${r.runtime}|${r.name.split('-')[0]}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const both = (xs: number[]) => `${Math.round(percentile(xs, 50))} / ${Math.round(percentile(xs, 95))}`;
  for (const [k, g] of groups) {
    const [runtime, scenario] = k.split('|');
    lines.push(`| ${runtime} | ${scenario} | ${g.length} | ${both(g.map((r) => r.ticks))} | ${both(g.map((r) => Math.max(...r.uploadChars) / 1000))} | ${both(g.map((r) => r.batches))} | ${both(g.map((r) => r.unpackMs))} | ${both(g.map((r) => r.signaturesMs))} | ${both(g.map((r) => r.replayMs))} | ${both(g.map((r) => r.totalMs))} | ${both(g.map((r) => r.cpuMs))} | ${both(g.map((r) => r.warmJudgeMs))} | ${both(g.map((r) => r.rssStartMb))} | ${both(g.map((r) => r.rssMb))} | ${both(g.map((r) => r.heapMb))} |`);
  }
  return lines.join('\n');
}

async function main(args: string[]) {
  const [cmd, ...rest] = args;
  if (cmd === 'gen') {
    const [dir, n = '5', quarterLen = '120'] = rest;
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < Number(n); i++) {
      const played = await playMatch(1000 + i, Number(quarterLen));
      played.fixture.name = `honest-${i}`;
      const hostile = await hostileFixture(played);
      for (const fx of [played.fixture, hostile]) writeFileSync(`${dir}/${fx.name}.json`, JSON.stringify(fx));
      console.error(`${played.fixture.name}: ${played.fixture.ticks} ticks, score ${played.fixture.score}, uploads ${played.fixture.uploads.map((u) => u.length)}, hostile ${hostile.uploads[0].length}`);
    }
  } else if (cmd === 'judge') {
    const fx = JSON.parse(readFileSync(rest[0], 'utf8')) as Fixture;
    const runtime = 'Deno' in globalThis ? `deno ${(globalThis as unknown as { Deno: { version: { deno: string } } }).Deno.version.deno}` : `node ${process.version}`;
    console.log(JSON.stringify(await measure(fx, runtime)));
  } else if (cmd === 'summary') {
    console.log(summarize(rest.flatMap((f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Measured))));
  } else {
    throw new Error('usage: judge-bench gen <dir> [matches] [quarterLen] | judge <fixture.json> | summary <results.jsonl>...');
  }
}

// Both runtimes set import.meta.main for the entry file; vitest doesn't, so the smoke test only gets the exports.
if ((import.meta as unknown as { main?: boolean }).main) await main(process.argv.slice(2));
