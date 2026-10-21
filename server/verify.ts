// Check a finished battle: `bun verify.ts <battle-id> [server-url]` or `bun verify.ts proof.json`.
// Confirms the server's seed matches the commitment published before the game, re-derives the game
// seed from all three seeds, replays every tick of input through the real engine and compares the result.

import { Game } from '../src/game/game';
import { stepGame } from '../src/game/sync';
import { configFromStart } from '../src/net/match';
import type { Proof } from '../src/net/protocol';
import { deriveSeed } from './battles';
import { hex, sha256 } from './lib/bytes';

export interface Verdict {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
  replayScore: [number, number];
}

export async function verifyProof(p: Proof): Promise<Verdict> {
  const checks: Verdict['checks'] = [];
  const commit = hex(await sha256(p.serverSeed));
  checks.push({ name: 'server seed matches the published commitment', ok: commit === p.commit, detail: commit });
  const seed = await deriveSeed(p.serverSeed, p.hostSeed, p.guestSeed, p.battleId);
  checks.push({ name: 'game seed derives from all three seeds', ok: seed === p.seed && seed === p.start.seed, detail: String(seed) });
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
  const [arg, base = 'http://localhost:8787'] = process.argv.slice(2);
  if (!arg) {
    console.log('usage: bun verify.ts <battle-id> [server-url] | bun verify.ts proof.json');
    process.exit(1);
  }
  const proof = arg.endsWith('.json')
    ? (JSON.parse(await Bun.file(arg).text()) as Proof)
    : ((await (await fetch(`${base}/api/battles/${arg}/proof`)).json()) as Proof);
  const v = await verifyProof(proof);
  for (const c of v.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  console.log(v.ok ? `\nVerified: ${proof.start.home.name} ${v.replayScore[0]} - ${v.replayScore[1]} ${proof.start.away.name}` : '\nNOT VERIFIED');
  process.exit(v.ok ? 0 : 2);
}
