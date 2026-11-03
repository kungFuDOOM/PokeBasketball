import { describe, expect, it } from 'vitest';
import { ALL_TIER_NAMES } from '../ranked/rank';
import { personLabel } from './reportsView';
import { rankedPlayersHtml, rankedRank, rankedStatsHtml, shortWallet, type RankedPlayer, type RankedStats, type RankWindow } from './rankedView';

const win = (over: Partial<RankWindow> = {}): RankWindow => ({
  matches: 0, players: 0, new_profiles: 0, forfeits: 0, leaves: 0, voids: 0, shields_used: 0, shield_packs: 0, shield_units: 0, ...over,
});

const stats = (over: Partial<RankedStats> = {}): RankedStats => ({
  d1: win({ matches: 2, players: 2, new_profiles: 1, forfeits: 1, shields_used: 1, shield_packs: 1, shield_units: 3 }),
  d7: win({ matches: 3, players: 3 }),
  d30: win({ matches: 4, players: 3, new_profiles: 3, shields_used: 2, shield_packs: 2, shield_units: 17 }),
  days: [{ day: '2026-11-02', matches: 2, players: 2, forfeits: 1, leaves: 0, voids: 0 }],
  ranks: [
    { tier: 'Bronze', players: 0 }, { tier: 'Silver', players: 0 }, { tier: 'Gold', players: 4 },
    { tier: 'Platinum', players: 0 }, { tier: 'Diamond', players: 0 }, { tier: 'Prism', players: 2 },
    { tier: 'Eclipse', players: 0 }, { tier: 'Pokémon Master', players: 1 }, { tier: 'Zenith', players: 1 },
  ],
  season: { id: 1, number: 1, status: 'active', starts_at: '2026-10-01T07:00:00Z', ends_at: '2026-11-12T08:00:00Z', length_weeks: 6, ranked: 8, placing: 1 },
  previous_season: null,
  top: [
    { user_id: 'bbbbbbbb-1', name: '<b>Bravo</b>', div_idx: 24, points: 200, rating: 2600, wins: 10, losses: 2 },
    { user_id: 'dddddddd-1', name: 'Delta', div_idx: 15, points: 10, rating: 1510, wins: 4, losses: 1 },
  ],
  shields_held: 7,
  today_starts: '2026-11-02T08:00:00Z',
  generated_at: '2026-11-02T20:00:00Z',
  ...over,
});

const player = (over: Partial<RankedPlayer> = {}): RankedPlayer => ({
  user_id: 'aaaaaaaa-1111', name: 'Alpha', wallet: '5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p',
  status: 'ranked', div_idx: 7, points: 40, placements_played: 5, rating: 740, wins: 3, losses: 1, matches: 4,
  last_game_at: '2026-11-02T18:00:00Z', shields: 2, flags: 2, banned_until: null, ...over,
});

describe('ranked admin views', () => {
  it('shortens a public address and leaves a short one whole', () => {
    expect(shortWallet(null)).toBe('—');
    expect(shortWallet('short')).toBe('short');
    expect(shortWallet('5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p')).toBe('5nji…q16p');
  });

  it('names a rank the way the game does', () => {
    expect(rankedRank({ status: 'ranked', div_idx: 15, placements_played: 5 })).toBe('Prism 3');
    expect(rankedRank({ status: 'ranked', div_idx: 24, placements_played: 5 })).toBe('Zenith');
    expect(rankedRank({ status: 'placing', div_idx: 0, placements_played: 2 })).toBe('Placing 2/5');
  });

  it('shows the nine ranks in game order, the day table, and escaped top players', () => {
    const html = rankedStatsHtml(stats());
    const ranks = html.slice(html.indexOf('class="ranks"'), html.indexOf('Matches per day'));
    expect([...ranks.matchAll(/<td>([^<]+)<\/td><td>(\d+)<\/td>/g)].map((m) => [m[1], m[2]])).toEqual([
      ['Bronze', '0'], ['Silver', '0'], ['Gold', '4'], ['Platinum', '0'], ['Diamond', '0'],
      ['Prism', '2'], ['Eclipse', '0'], ['PokeJam Master', '1'], ['Zenith', '1'],
    ]);
    expect([...ALL_TIER_NAMES]).toEqual(['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Prism', 'Eclipse', 'PokeJam Master', 'Zenith']);
    expect(html).toContain('<th>Day (PT)</th>');
    expect(html).toContain('<td>2026-11-02</td><td>2</td>');
    expect(html).toContain('Season 1 (active)');
    expect(html).toContain('8 ranked, 1 still placing');
    expect(html).toContain('>2</b><span>Matches today (PT)</span>');
    expect(html).toContain('Shields held now');
    expect(html).toContain('&lt;b&gt;Bravo&lt;/b&gt;');
    expect(html).not.toContain('<b>Bravo</b>');
    expect(html).toContain('Zenith');
    expect(html).toContain('10–2');
    expect(html).toContain('class="scroll"');
  });

  it('says when there is no season and no ranked players', () => {
    const html = rankedStatsHtml(stats({ season: null, top: [], days: [], ranks: [] }));
    expect(html).toContain('No season is open.');
    expect(html).toContain('No ranked players yet.');
    expect(html).toContain('No days.');
    expect(html).toContain('<td>Prism</td><td>0</td>');
  });

  it('lists ranked players with the same suspend actions, a short wallet, and escaped text', () => {
    const html = rankedPlayersHtml({
      season_number: 1, season_status: 'active',
      players: [
        player({ name: '<b>x</b>', wallet: '<img src=x onerror=1>pad-wallet-xyz' }),
        player({
          user_id: 'bbbbbbbb-2222', name: 'Fvcker', wallet: null, status: 'placing', div_idx: 0, placements_played: 2,
          rating: 0, wins: 0, losses: 0, matches: 0, last_game_at: null, shields: 0, flags: 0,
          banned_until: '2120-01-01T00:00:00Z',
        }),
      ],
    });
    expect(html).toContain('Season 1 (active)');
    expect(html).toContain('class="scroll"');
    expect(html).toContain('class="ranked-players"');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<img');
    expect(html).toContain('title="&lt;img src=x onerror=1&gt;pad-wallet-xyz"');
    expect(html).toContain('&lt;img…-xyz');
    expect(html).toContain('Gold 2');
    expect(html).toContain('3–1');
    expect(html).toContain('>4</td>');
    expect(html).toContain('>2</td>'); // shields and flags
    expect(html).toContain('Placing 2/5');
    expect(html).toContain('bad name');
    expect(html).toContain('suspended permanently');
    expect(html).toContain('data-role="ranked"');
    expect(html).not.toContain('data-act="dismiss"');
    const alpha = html.slice(html.indexOf('aaaaaaaa'), html.indexOf('bbbbbbbb'));
    expect(alpha.match(/data-act="([^"]+)"/g)!.map((s) => s.match(/"([^"]+)"/)![1])).toEqual(['24', '168', '0', 'name']);
    expect(html).toContain('data-act="unban"');
    const banned = rankedPlayersHtml({
      season_number: 1, season_status: 'active',
      players: [player({ quit_offences: 4, ranked_ban_until: '2099-06-01T00:00:00Z' })],
    });
    expect(banned).toContain('Ranked quits: 4');
    expect(banned).toContain('Ranked banned until');
    expect(banned).toContain('data-act="clear-ranked"');
    expect(banned).toContain('data-role="ranked"');
    expect(html).toContain('data-user="bbbbbbbb-2222"');
    expect(personLabel('Fvcker', 'ranked')).toBe('Fvcker (ranked)');
  });

  it('says so when the season has no players', () => {
    expect(rankedPlayersHtml({ season_number: null, season_status: null, players: [] })).toContain('No season is open.');
    expect(rankedPlayersHtml({ season_number: 2, season_status: 'closed', players: [] })).toContain('No ranked players this season.');
  });
});
