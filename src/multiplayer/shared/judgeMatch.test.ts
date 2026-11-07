// The Pack Battles judge on real games: two clients play a full lockstep game over a lossy link, signing what they
// send; their packed uploads are judged with the setup rebuilt from the "match row", as the Edge Function does.
// (supabase/tests/pack-judge-bundle.test.ts checks the committed Deno bundle against this.)
import { describe, expect, it } from 'vitest';
import { pack } from './evidence';
import { hostMatch, playedBattle } from './judgeMatch.fixture';
import { judgeBattle } from './judgeMatch';
import { MIN_DELAY } from './lockstep';
import { setupFor } from './netplay';
import { matchKey, signResign, signTicks } from './winnerCheck';

describe('the Pack Battles judge', () => {
  it('names the player who won a real game, from the server row and both uploads (and from one upload alone)', async () => {
    let checked = 0;
    for (const seed of [21, 34, 55]) {
      const { row, games } = await playedBattle(seed);
      const [h, g] = games[0].score;
      if (h === g) continue;
      const s = await judgeBattle(row);
      expect(s.outcome).toBe('final');
      expect(s.result).toBe(h > g ? 'host' : 'guest');
      expect(s.verdict!.score).toEqual([h, g]);
      expect((await judgeBattle({ ...row, uploads: [row.uploads[1]] })).result).toBe(s.result);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }, 300_000);

  it('trusts the match row, not the upload: a doctored setup in an upload changes nothing', async () => {
    const { row, games } = await playedBattle(89);
    const [h, g] = games[0].score;
    // Swap the seed on the row: the judge replays a different game, which can't match the signed inputs' result.
    const real = await judgeBattle(row);
    const other = await judgeBattle({ ...row, seed: 90 });
    expect(real.verdict!.score).toEqual([h, g]);
    expect(other.verdict!.score).not.toEqual([h, g]);
  }, 300_000);

  it('a player who leaves on purpose forfeits: their signed resignation is the proof', async () => {
    const left = await playedBattle(144, { stopAt: 300, resign: 1 });
    expect(await judgeBattle(left.row)).toMatchObject({ result: 'host', outcome: 'resigned' });
    // The stayer's upload alone is enough: it holds the resignation the leaver sent with its goodbye.
    expect(await judgeBattle({ ...left.row, uploads: [left.row.uploads[0]], guest_uploaded: false })).toMatchObject({ result: 'host', outcome: 'resigned' });
    const hostLeft = await playedBattle(145, { stopAt: 300, resign: 0 });
    expect(await judgeBattle(hostLeft.row)).toMatchObject({ result: 'guest', outcome: 'resigned' });
  }, 300_000);

  it('a resignation only counts if it is real, and only before the buzzer', async () => {
    const early = await playedBattle(146, { stopAt: 300 });
    // A resignation "from the guest" signed with some other key is ignored: no proof of who quit.
    const forgery = { side: 1 as const, sig: (await signResign((await matchKey()).privateKey, early.row.match_id, 1)).sig };
    const forged = await pack({ setup: setupFor(hostMatch(early.row)), keys: [early.row.host_key!, early.row.guest_key!], inputs: [], applied: [], lockstep: { emptyTicks: MIN_DELAY }, resigns: [forgery] });
    expect(await judgeBattle({ ...early.row, uploads: [...early.row.uploads, forged] })).toMatchObject({ result: 'review', outcome: 'disconnect' });
    // A game played to the buzzer stands, whoever "resigns" after it.
    const done = await playedBattle(21, { resign: 0 });
    const [h, g] = done.games[0].score;
    if (h !== g) expect(await judgeBattle(done.row)).toMatchObject({ result: h > g ? 'host' : 'guest', outcome: 'final' });
  }, 300_000);

  it('a player who goes quiet and never uploads forfeits; with both still there, a person decides', async () => {
    const early = await playedBattle(147, { stopAt: 300 });
    // Only the host uploaded (after the 3-minute wait): the guest left without a word.
    expect(await judgeBattle({ ...early.row, uploads: [early.row.uploads[0]], guest_uploaded: false })).toMatchObject({ result: 'host', outcome: 'abandoned' });
    expect(await judgeBattle({ ...early.row, uploads: [early.row.uploads[1]], host_uploaded: false })).toMatchObject({ result: 'guest', outcome: 'abandoned' });
    // Both stayed and uploaded, each saying the other went quiet: their inputs can't tell a dropped link from a
    // dodged loss, so nothing moves until a person has read both connection logs.
    const both = await judgeBattle(early.row);
    expect(both).toMatchObject({ result: 'review', outcome: 'disconnect' });
    expect(both.note).toMatch(/connection logs/);
  }, 300_000);

  it('voids a game that never got going, and holds unjudgeable evidence for a person', async () => {
    const early = await playedBattle(148, { stopAt: 300 });
    expect(await judgeBattle({ ...early.row, host_key: null })).toMatchObject({ result: 'void', outcome: 'no-game' });
    expect(await judgeBattle({ ...early.row, uploads: [], host_uploaded: false, guest_uploaded: false })).toMatchObject({ result: 'void', outcome: 'no-game' });
    const tipOff = await playedBattle(149, { stopAt: 0 });
    expect(await judgeBattle({ ...tipOff.row, uploads: [tipOff.row.uploads[0]], guest_uploaded: false })).toMatchObject({ result: 'void', outcome: 'no-game' });
    expect(await judgeBattle({ ...early.row, uploads: ['gz1:not-gzip'], guest_uploaded: false })).toMatchObject({ result: 'review', outcome: 'no-evidence' });
    const forged = { ...early.row, guest_key: (await matchKey()).publicKey };
    expect((await judgeBattle(forged)).result).not.toMatch(/host|guest/);
  }, 300_000);

  it('a player who signs two versions of the same input forfeits to the other', async () => {
    const { row, keys } = await playedBattle(233, { stopAt: 600 });
    const rewrite = await signTicks(keys[1].privateKey, row.match_id, 1, 400, [{ mx: 1, my: -1, b: 2 }]);
    const extra = await pack({ setup: setupFor(hostMatch(row)),
      keys: [row.host_key!, row.guest_key!], inputs: [rewrite], applied: [], lockstep: { emptyTicks: MIN_DELAY } });
    expect(await judgeBattle({ ...row, uploads: [...row.uploads, extra] })).toMatchObject({ result: 'host', outcome: 'forfeit' });
  }, 300_000);
});
