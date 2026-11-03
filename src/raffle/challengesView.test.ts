// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { challengesHtml, modelFromDefaults, modelFromServer, resetLabel } from './challengesView';
import type { RaffleMe } from './client';

const me = (over: Partial<RaffleMe> = {}): RaffleMe => ({
  signed_in: true, week_start: '2026-11-02', resets_at: '2026-11-09T08:00:00.000Z',
  config: { offline_games: 3, online_games: 3, social: 1, rank_steps: 1, pjam_per_entry: 1_000_000, pjam_mint: 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump', grind_online_per_entry: 10, grind_wins_per_entry: 3, bonus_cap: 5 },
  counts: { offline: 3, online: 13, online_wins: 3, social_matches: 1, shares: 0, rank_steps: 1, zenith: false },
  score: {
    base: true, grind: 1, holder: 0, bonus: 1, total: 2, social_have: 1, rank_done: true,
    offline: { have: 3, need: 3, done: true }, online: { have: 13, need: 3, done: true },
    social: { have: 1, need: 1, done: true }, rank: { have: 1, need: 1, done: true, zenith: false },
  },
  wallet: '5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p', last_draw: null, ...over,
});

describe('challenges screen', () => {
  it('states both bonus routes, the cap, and that no purchase is needed', () => {
    const html = challengesHtml(modelFromServer(me()));
    expect(html).toContain('No purchase needed');
    expect(html).toContain('1,000,000 PJAM');
    expect(html).toContain('10 extra online games');
    expect(html).toContain('3 online wins');
    expect(html).toContain('up to 5');
    expect(html).toContain('your entries divided by');
    expect(html).toContain('raffle-rules.html');
    expect(html).toContain('5nji…q16p');
    expect(html).toContain('Entries so far');
    expect(html).toContain('>2<');
    expect(html).not.toContain('5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p</');
  });

  it('escapes a name-like error and shows the guest prompt from the defaults', () => {
    const html = challengesHtml(modelFromDefaults(), '<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('Sign in');
    expect(html).toContain('0/3');
    expect(html).toContain('Monday 00:00 PT');
  });

  it('labels Zenith and a previous win', () => {
    const html = challengesHtml(modelFromServer(me({
      score: { ...me().score, rank: { have: 0, need: 1, done: true, zenith: true } },
      last_draw: { week_start: '2026-10-26', won: true, entries: 2, total: 4 },
    })));
    expect(html).toContain('Zenith, the top rank');
    expect(html).toContain('You won');
    expect(html).toContain('2 of 4');
  });

  it('formats the reset in Pacific time', () => {
    expect(resetLabel('2026-11-09T08:00:00.000Z')).toMatch(/Nov/);
    expect(resetLabel('nope')).toBe('Monday 00:00 PT');
  });

  it('the layout keeps clear of the notch and fits a short landscape phone', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.menu:has\(\.ch\)[\s\S]*safe-area-inset-left/);
    expect(css).toMatch(/max-height: 450px[\s\S]*\.menu:has\(\.ch\)/);
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toContain('viewport-fit=cover');
  });
});
