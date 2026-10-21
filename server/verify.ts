// Check a finished battle: `bun verify.ts <battle-id> [server-url]` or `bun verify.ts proof.json`.
//
// 1. The server seed matches the commitment published before anyone played.
// 2. The pull's VRF output is what Collector Crypt published for that memo (asks CC unless --offline).
// 3. The draft's first pick and the game seed derive from the four sources exactly as the recipe says.
// 4. Replaying every tick of input through the real engine gives the published score and winner.

import { Game } from '../src/game/game';
import { stepGame } from '../src/game/sync';
import { configFromStart } from '../src/net/match';
import type { Proof } from '../src/net/protocol';
import { deriveSeed, firstPick } from './battles';
import { CC_PROD, betaFrom } from './collector-crypt';
import { hex, sha256 } from './lib/bytes';

export interface Verdict {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
  replayScore: [number, number];
}

export async function verifyProof(p: Proof, opts: { ccBase?: string; offline?: boolean } = {}): Promise<Verdict> {
  const checks: Verdict['checks'] = [];
  const commit = hex(await sha256(p.serverSeed));
  checks.push({ name: 'server seed matches the commitment published before the game', ok: commit === p.commit, detail: commit });

  if (!p.pull) {
    checks.push({ name: 'battle has a Collector Crypt pull', ok: false, detail: 'no pull in the proof' });
  } else {
    const published = betaFrom(p.pull.vrf);
    if (published) checks.push({ name: "entropy is the VRF output in Collector Crypt's record", ok: published === p.pull.entropy, detail: `memo ${p.pull.memo}` });
    if (!opts.offline) {
      try {
        const res = await fetch(`${(opts.ccBase ?? CC_PROD).replace(/\/$/, '')}/api/vrf/verify?memo=${encodeURIComponent(p.pull.memo)}`);
        const live = (await res.json()) as Record<string, unknown>;
        const beta = betaFrom(live);
        const matchFlag = Object.entries(live).find(([k]) => /match/i.test(k))?.[1];
        checks.push({ name: 'Collector Crypt confirms this VRF output for the memo (live)', ok: res.ok && (beta ? beta === p.pull.entropy : true) && matchFlag !== false,
          detail: beta ? `beta ${beta.slice(0, 16)}…` : 'no beta field in the live record; see its match flag' });
      } catch (e) {
        checks.push({ name: 'Collector Crypt confirms this VRF output for the memo (live)', ok: false, detail: `could not reach Collector Crypt: ${(e as Error).message}` });
      }
    }
    const seed = await deriveSeed(p.serverSeed, p.hostSeed, p.guestSeed, p.battleId, p.pull.entropy);
    checks.push({ name: 'game seed derives from server, host, guest seeds and the VRF output', ok: seed === p.seed && seed === p.start.seed, detail: String(seed) });
  }
  const first = await firstPick(p.serverSeed, p.hostSeed, p.guestSeed, p.battleId);
  checks.push({ name: 'first draft pick derives from the committed seeds', ok: !!p.draft && p.draft.order[0] === first, detail: `${first === 0 ? 'host' : 'guest'} picks first` });
  if (p.draft) {
    const roster = (s: 0 | 1) => p.draft!.picks.filter((_, i) => p.draft!.order[i] === s);
    const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    checks.push({ name: 'teams in the game are exactly the drafted teams', ok: same(roster(0), p.start.home.roster) && same(roster(1), p.start.away.roster) });
  }

  const g = new Game(configFromStart(p.start));
  for (const ins of p.inputs) {
    stepGame(g, ins);
    g.events.length = 0;
    g.sfx.length = 0;
  }
  const replayScore: [number, number] = [g.score[0], g.score[1]];
  if (p.forfeit) {
    checks.push({ name: 'forfeit: score at the moment a player left', ok: replayScore[0] === p.score[0] && replayScore[1] === p.score[1] });
  } else {
    checks.push({ name: 'replay reaches the final buzzer', ok: g.phase === 'final' });
    checks.push({ name: 'replayed score matches the result', ok: replayScore[0] === p.score[0] && replayScore[1] === p.score[1], detail: replayScore.join('-') });
    checks.push({ name: 'winner matches the replay', ok: (replayScore[0] > replayScore[1] ? 0 : 1) === p.winner });
  }
  return { ok: checks.every((c) => c.ok), checks, replayScore };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const [arg, base = 'http://localhost:8787'] = args.filter((a) => !a.startsWith('--'));
  if (!arg) {
    console.log('usage: bun verify.ts <battle-id> [server-url] [--offline] | bun verify.ts proof.json [--offline]');
    process.exit(1);
  }
  const proof = arg.endsWith('.json')
    ? (JSON.parse(await Bun.file(arg).text()) as Proof)
    : ((await (await fetch(`${base}/api/battles/${arg}/proof`)).json()) as Proof);
  const v = await verifyProof(proof, { offline, ccBase: process.env.CC_BASE_URL });
  console.log(`Seed recipe: ${proof.seedRecipe}\n`);
  for (const c of v.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  console.log(v.ok ? `\nVerified: ${proof.start.home.name} ${v.replayScore[0]} - ${v.replayScore[1]} ${proof.start.away.name}` : '\nNOT VERIFIED');
  process.exit(v.ok ? 0 : 2);
}
