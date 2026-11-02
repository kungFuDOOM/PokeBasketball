// Smoke test for scripts/judge-bench.ts on a very short match, so the harness can't rot. The real benchmark is run by
// hand (see the top of that file): it takes minutes and its numbers depend on the machine.
import { describe, expect, it } from 'vitest';
import { hostileFixture, measure, playMatch, summarize } from '../../../../scripts/judge-bench';
import { unpack } from '../../../../src/multiplayer/shared/evidence';

describe('judge benchmark harness', () => {
  it('plays a real match whose uploads the judge replays to the score both clients saw', async () => {
    const played = await playMatch(7, 2);
    const m = await measure(played.fixture, 'test');
    expect(m.status).toBe('final');
    expect(m.ticks).toBe(played.fixture.ticks);
    expect(m.batches).toBeGreaterThan(0);
    for (const k of ['unpackMs', 'signaturesMs', 'replayMs', 'cpuMs'] as const) expect(m[k]).toBeGreaterThan(0);
    expect(m.totalMs).toBeCloseTo(m.unpackMs + m.signaturesMs + m.replayMs);
  }, 60_000);

  it('the hostile upload is one signature check per frame, and still judges to the same result', async () => {
    const played = await playMatch(8, 2);
    const hostile = await hostileFixture(played);
    const ev = await unpack(hostile.uploads[0]);
    expect(ev.inputs.every((b) => b.side === 0 && b.frames.length === 1)).toBe(true);
    const [honest, bad] = [await measure(played.fixture, 'test'), await measure(hostile, 'test')];
    expect(bad.status).toBe('final');
    expect(bad.ticks).toBe(honest.ticks);
    expect(bad.batches).toBeGreaterThan(honest.batches);
  }, 60_000);

  it('summarizes runs per runtime and scenario', () => {
    const row = { runtime: 'deno', name: 'honest-0', ticks: 100, uploadChars: [1000], batches: 5, status: 'final', loadMs: 1, unpackMs: 1, signaturesMs: 2, replayMs: 3, totalMs: 6, cpuMs: 7, warmJudgeMs: 4, rssStartMb: 8, rssMb: 9, heapMb: 10 };
    const table = summarize([row, { ...row, name: 'honest-1', totalMs: 8 }, { ...row, name: 'hostile-0' }]);
    expect(table).toContain('| deno | honest | 2 | 100 / 100 | 1 / 1 | 5 / 5 | 1 / 1 | 2 / 2 | 3 / 3 | 6 / 8 |');
    expect(table).toContain('| deno | hostile | 1 |');
  });
});
