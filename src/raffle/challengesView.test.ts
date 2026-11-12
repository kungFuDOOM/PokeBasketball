// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { challengesHtml, compactTokenAmount, holderOfferText, modelFromDefaults, modelFromServer, resetLabel, weeklyChallengesTickerHtml, weeklyChallengesTickerText } from './challengesView';
import { RAFFLE_DEFAULTS } from './entries';
import { THIS_WEEK_PRIZE, prizeHtml, usd, type WeeklyCardPrize } from './prize';
import { monByDex } from '../data/pokemon';
import { KANTO } from '../franchise/regions';
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
    expect(html).toContain(holderOfferText());
    expect(html).toContain('Hold 1M $PJAM and link your wallet to enter automatically, 1 entry per 1M, up to 5M counted');
    expect(html).toContain('10 extra online games');
    expect(html).toContain('3 online wins');
    expect(html).toContain('up to 5');
    expect(html).toContain('Checking holder entries');
    expect(html).toContain('your entries divided by');
    expect(html).toContain('raffle-rules.html');
    expect(html).toContain('AZ&#39;s Tranquility');
    expect(html).toContain('$115.00');
    expect(html).toContain('$103.50');
    expect(html).toContain('sent by hand');
    expect(html).toContain('does not take payment');
    expect(html).toContain('5nji…q16p');
    expect(html).toContain('Challenge entries so far');
    expect(html).toContain('Your entries this week');
    expect(html).toContain('>2<');
    expect(html).not.toContain('5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p</');
  });

  it('escapes a name-like error and shows the guest prompt from the defaults', () => {
    const html = challengesHtml(modelFromDefaults(), '<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('raffle/azs-tranquility-psa10.webp');
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

  it("shows this week's AZ's Tranquility prize, value, and buyback", () => {
    const html = challengesHtml(modelFromDefaults());
    expect(html).toContain('AZ&#39;s Tranquility');
    expect(html).toContain('Supporter / Trainer');
    expect(html).toContain('2026 Pokémon CRI EN');
    expect(html).toContain('#120');
    expect(html).toContain('120/086');
    expect(html).toContain('Special Illustration Rare');
    expect(html).toContain('PSA Gem Mint 10');
    expect(html).toContain('1624777451');
    expect(html).toContain('$115.00');
    expect(html).toContain('$103.50');
    expect(html).toContain('OmniVault');
    expect(html).toContain('Collector Crypt');
    expect(html).toContain('raffle/azs-tranquility-psa10.webp');
    expect(html).toContain('This week\'s prize');
    expect(html).toContain('The prize is a Pokémon card, sent by hand.');
    expect(html).not.toContain('Owned by');
    expect(html).not.toContain('$0.18');
    expect(usd(THIS_WEEK_PRIZE.valueCents)).toBe('$115.00');
    expect(usd(THIS_WEEK_PRIZE.buybackCents)).toBe('$103.50');
    const next: WeeklyCardPrize = { ...THIS_WEEK_PRIZE, id: 'later', name: 'Next Week Card', valueCents: 200, buybackCents: 150 };
    const swapped = prizeHtml(next);
    expect(swapped).toContain('Next Week Card');
    expect(swapped).toContain('$2.00');
    expect(swapped).toContain('$1.50');
    expect(swapped).not.toContain('AZ&#39;s Tranquility');
  });

  it('does not change Kanto or the live starter cards', () => {
    expect(monByDex(6)).toMatchObject({ name: 'Charizard', ovr: 91, pos: 'SF' });
    expect(monByDex(3)).toMatchObject({ name: 'Venusaur', ovr: 88 });
    expect(monByDex(9)).toMatchObject({ name: 'Blastoise', ovr: 88 });
    expect(KANTO.gyms.map((g) => g.badge)).toEqual(['Boulder', 'Cascade', 'Thunder', 'Rainbow', 'Soul', 'Marsh', 'Volcano', 'Earth']);
    expect(KANTO.id).toBe('kanto');
  });

  it('formats the reset in Pacific time', () => {
    expect(resetLabel('2026-11-09T08:00:00.000Z')).toMatch(/Nov/);
    expect(resetLabel('nope')).toBe('Monday 00:00 PT');
  });

  it('the menu ticker line follows the raffle defaults and does not hardcode a stale amount', () => {
    expect(compactTokenAmount(1_000_000)).toBe('1M');
    expect(compactTokenAmount(2_000_000)).toBe('2M');
    expect(compactTokenAmount(2_500_000)).toBe('2,500,000');
    const text = weeklyChallengesTickerText();
    expect(text).toBe(`Weekly Challenges are live — hold ${compactTokenAmount(RAFFLE_DEFAULTS.pjamPerEntry)} $PJAM and link your wallet to enter automatically, or finish all weekly challenges, for a chance to win a Pokémon card!`);
    expect(text).toContain('1M $PJAM');
    expect(text).not.toMatch(/Pokémon Master/);
    expect(text).not.toContain('to win a free');
    expect(weeklyChallengesTickerHtml()).toBe(text);
    expect(weeklyChallengesTickerText({ ...RAFFLE_DEFAULTS, pjamPerEntry: 3_000_000 })).toContain('hold 3M $PJAM');
    expect(holderOfferText({ ...RAFFLE_DEFAULTS, pjamPerEntry: 2_000_000, pjamCountedCap: 8_000_000 })).toBe('Hold 2M $PJAM and link your wallet to enter automatically, 1 entry per 2M, up to 8M counted');
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    const rule = css.match(/\.ticker \{[^}]+\}/)?.[0] ?? '';
    expect(rule).toContain('safe-area-inset-left');
    expect(rule).toContain('safe-area-inset-right');
    expect(rule).toContain('safe-area-inset-bottom');
    expect(css).toContain('.tk-clip');
    expect(css).toMatch(/\.ticker\.static \.tk-clip \{[^}]*safe center/);
  });

  it('offers a wallet link when none is stored, and shows holder entries once they are known', () => {
    const open = challengesHtml(modelFromServer(me({ wallet: null, score: { ...me().score, base: false, holder: 0, bonus: 0, total: 0 } })));
    expect(open).toContain('data-a="link-wallet"');
    expect(open).toContain('No wallet linked yet');
    expect(open).toContain('Link your wallet');
    const known = challengesHtml({ ...modelFromServer(me()), holderNow: 3 });
    expect(known).toContain('Holder entries: 3.');
    expect(known).toContain('Your entries this week: <b>5</b>');
    expect(known).not.toContain('data-a="link-wallet"');
    const files = ['client.ts', 'screen.ts', 'challengesView.ts'].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).join('\n');
    expect(files).toContain('pokejam-raffle-holder');
    expect(files).not.toMatch(/getAccountInfo|getBalance|RAFFLE_RPC|\.solana\.com|jsonrpc/);
  });

  it('the layout keeps clear of the notch and fits a short landscape phone', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.menu:has\(\.ch\)[\s\S]*safe-area-inset-left/);
    expect(css).toMatch(/max-height: 450px[\s\S]*\.menu:has\(\.ch\)/);
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toContain('viewport-fit=cover');
  });
});
