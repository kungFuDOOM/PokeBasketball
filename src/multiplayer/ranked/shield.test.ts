// Rank Shield item: server parsing (every field optional) and the hub / post-match / queue HTML.
import { describe, expect, it } from 'vitest';
import type { ReportOutcome } from '../shared/matchService';
import { parseMe, parseRankResult, parseShieldStatus, type RankedMe } from './serverRank';
import { postMatchHtml, resetsText, shieldItemHtml, shieldTagHtml, waitText, weeklyCardHtml } from './view';

const me = (o: Partial<RankedMe> = {}): RankedMe => ({
  season: 1, daysLeft: 31, placing: false, placementsPlayed: 5, divIdx: 7, points: 40, zenith: false, shieldCharge: 1, shieldLossesLeft: null,
  shieldActive: true, wins: 3, losses: 2, cooldownUntil: null, ...o,
});
const done = (result: unknown, m: RankedMe | null = null): ReportOutcome => ({ queue: 'ranked', status: 'done', result: parseRankResult(result) ?? undefined, me: m ?? undefined });
const NOW = Date.parse('2026-11-04T12:00:00Z');
const item = (o: Record<string, unknown> = {}) => parseShieldStatus({ count: 3, armed: false, locked: false, next_use_at: null, arm_block: null, ...o })!;

describe('parsing', () => {
  it('missing shield fields mean none; junk never throws', () => {
    expect(parseMe({ status: 'ranked', div_idx: 7 })?.shieldItem).toBeUndefined();
    expect(parseMe({ status: 'ranked', div_idx: 7, shield_item_count: 2, shield_item_armed: true, shield_item_locked: false, shield_item_next_use: '2026-11-05T00:00:00Z', shield_item_block: 'used_today' })?.shieldItem)
      .toEqual({ count: 2, armed: true, locked: false, nextUseAt: '2026-11-05T00:00:00Z', block: 'used_today' });
    expect(parseMe({ status: 'ranked', shield_item_count: 'x' })?.shieldItem).toBeUndefined();
    expect(parseMe({ status: 'ranked', shield_item_count: 1, shield_item_block: 'bogus' })?.shieldItem?.block).toBeNull();
    for (const bad of [null, undefined, 'x', 7, [], {}]) expect(parseShieldStatus(bad)).toBeNull();
    expect(parseShieldStatus({ count: 1 })).toMatchObject({ count: 1, armed: false, locked: false, weekly: null });
    expect(parseShieldStatus({ count: 1, weekly: { kind: 'wins', goal: 4, progress: 9, done: false, resets_at: '2026-11-09T00:00:00Z' } })?.weekly)
      .toEqual({ kind: 'wins', goal: 4, progress: 4, done: false, resetsAt: '2026-11-09T00:00:00Z' });
  });

  it('reads the shield part of a match result, and its absence', () => {
    expect(parseRankResult({ placing: false, delta: 0, shield: { armed: true, used: true, saved: 17 } })?.shield).toEqual({ armed: true, used: true, saved: 17 });
    expect(parseRankResult({ placing: false, delta: 20, shield: { armed: true, used: false, saved: 0 } })?.shield).toEqual({ armed: true, used: false, saved: 0 });
    expect(parseRankResult({ placing: false, delta: 20 })).not.toHaveProperty('shield');
    expect(parseRankResult({ placing: false, delta: 20, shield: 'yes' })).not.toHaveProperty('shield');
  });
});

describe('formatting', () => {
  it('waits and resets', () => {
    expect(waitText(5 * 3_600_000 + 12 * 60_000)).toBe('5 h 12 m');
    expect(waitText(12 * 60_000)).toBe('12 m');
    expect(waitText(10)).toBe('1 m');
    expect(resetsText(3 * 86_400_000 + 5 * 3_600_000)).toBe('3 d');
    expect(resetsText(5 * 3_600_000 - 1)).toBe('5 h');
  });
});

describe('Rank Shield chip', () => {
  it('shows the count and an ARM toggle', () => {
    expect(shieldItemHtml(item(), NOW)).toMatch(/x3[\s\S]*data-a="arm" aria-pressed="false">ARM</);
    expect(shieldItemHtml(item({ armed: true }), NOW)).toContain('aria-pressed="true">ARMED');
    expect(shieldItemHtml(null)).toBe('');
  });
  it('is locked once paired', () => {
    const h = shieldItemHtml(item({ armed: true, locked: true }), NOW);
    expect(h).toContain('Armed for this match');
    expect(h).toContain(' disabled');
  });
  it('says why it is off', () => {
    expect(shieldItemHtml(item({ arm_block: 'used_today', next_use_at: new Date(NOW + 5 * 3_600_000 + 12 * 60_000).toISOString() }), NOW)).toContain('Used today - back in 5 h 12 m');
    expect(shieldItemHtml(item({ arm_block: 'placing' }), NOW)).toContain('Placement games can&#39;t be shielded');
    expect(shieldItemHtml(item({ arm_block: 'nothing_to_lose' }), NOW)).toContain('Nothing to lose');
    expect(shieldItemHtml(item({ arm_block: 'zenith' }), NOW)).toContain('Not in Zenith');
    expect(shieldItemHtml(item({ count: 0, arm_block: 'empty' }), NOW)).toMatch(/x0[\s\S]*disabled/);
    expect(shieldItemHtml(item({ arm_block: 'zenith' }), NOW)).toContain(' disabled');
  });
  it('an armed shield can always be taken back', () => {
    expect(shieldItemHtml(item({ armed: true, arm_block: 'used_today' }), NOW)).not.toContain(' disabled');
  });
});

describe('weekly card', () => {
  const w = (o: Record<string, unknown> = {}) => parseShieldStatus({ count: 0, weekly: { kind: 'games', goal: 10, progress: 6, done: false, resets_at: new Date(NOW + 3.5 * 86_400_000).toISOString(), ...o } })!.weekly;
  it('shows progress, reset and reward', () => {
    const h = weeklyCardHtml(w(), NOW);
    expect(h).toContain('Play 10 ranked games');
    expect(h).toContain('6/10');
    expect(h).toContain('resets in 3 d');
    expect(h).toContain('1 free Rank Shield');
    expect(h).toContain('width:60%');
  });
  it('says Done this week once complete, and follows the configured kind', () => {
    expect(weeklyCardHtml(w({ progress: 10, done: true }), NOW)).toContain('Done this week');
    expect(weeklyCardHtml(w({ kind: 'wins', goal: 4, progress: 1 }), NOW)).toContain('Win 4 ranked games');
    expect(weeklyCardHtml(w({ kind: 'days', goal: 4, progress: 1 }), NOW)).toContain('Play ranked on 4 different days');
    expect(weeklyCardHtml(null)).toBe('');
  });
});

describe('post-match line', () => {
  it('says what the shield saved', () => {
    const h = postMatchHtml(done({ placing: false, event: null, placements_played: 5, before: 740, after: 740, delta: 0, div_idx: 7, points: 40, shield: { armed: true, used: true, saved: 14 } }, me()), false);
    expect(h).toContain('Rank Shield saved you 14 points');
    expect(postMatchHtml(done({ placing: false, delta: 0, shield: { armed: true, used: true, saved: 1 } }), false)).toContain('saved you 1 point<');
  });
  it('says the shield was kept after a win, and only then', () => {
    const kept = postMatchHtml(done({ placing: false, delta: 22, before: 740, after: 762, div_idx: 7, points: 62, shield: { armed: true, used: false, saved: 0 } }, me()), true);
    expect(kept).toContain('Shield kept - you won');
    expect(postMatchHtml(done({ placing: false, delta: -19, before: 740, after: 721, div_idx: 7, points: 21, shield: { armed: true, used: false, saved: 0 } }), false)).not.toContain('Shield kept');
    expect(postMatchHtml(done({ placing: false, delta: 22, before: 740, after: 762, div_idx: 7, points: 62 }), true)).not.toContain('Rank Shield');
  });
});

describe('queue tag', () => {
  it('appears only when armed', () => {
    expect(shieldTagHtml(item({ armed: true }))).toContain('Shield armed');
    expect(shieldTagHtml(item())).toBe('');
    expect(shieldTagHtml(null)).toBe('');
  });
});
