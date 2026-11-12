// The pokejam-pack-judge Edge Function runs a bundle of the app's judge (scripts/build-pack-judge.mjs). It must be
// current, and judge a real game exactly as the app's sources do.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judgeBattle } from '../../src/multiplayer/shared/judgeMatch';
import { playedBattle } from '../../src/multiplayer/shared/judgeMatch.fixture';
// @ts-expect-error: a plain ES module
import { bundleText, OUT } from '../../scripts/build-pack-judge.mjs';

/** Line endings aside: a Windows checkout may turn them into CRLF. */
const lf = (t: string) => t.split('\r\n').join('\n');

describe('the judge bundle', () => {
  it('is current (run `npm run build:judge` if this fails), and judges a real game the same way', async () => {
    expect(lf(readFileSync(OUT, 'utf8'))).toBe(lf(await bundleText()));
    const bundled = await import(/* @vite-ignore */ new URL('../functions/pokejam-pack-judge/judge.bundle.js', import.meta.url).href);
    const { row } = await playedBattle(377);
    const a = await judgeBattle(row);
    const b = await bundled.judgeBattle(row);
    expect(a.outcome).toBe('final');
    expect({ result: b.result, outcome: b.outcome, score: b.verdict?.score }).toEqual({ result: a.result, outcome: a.outcome, score: a.verdict?.score });
  }, 300_000);
});
