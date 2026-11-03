import { describe, expect, it } from 'vitest';
import apiSource from './api.ts?raw';
import { DM_CONTACTS, DM_ONLY, isPlan, offers, pickPlan, planBadges, savePercent, type BoardPlan } from './plans';
import plansSource from './plans.ts?raw';
import screenSource from './screen.ts?raw';
import usdcSource from './usdcPay.ts?raw';

const M = 1_000_000n;
const PLANS: BoardPlan[] = [
  { method: 'usdc', plan: 'month', hours: 720, amount: String(500n * M) },
  { method: 'burn', plan: 'week', hours: 168, amount: String(7_500_000n * M) },
  { method: 'burn', plan: 'hour', hours: 1, amount: String(100_000n * M) },
  { method: 'usdc', plan: 'week', hours: 168, amount: String(150n * M) },
];

describe('the plans on the Advertise page', () => {
  it('come from the server, per way to pay, shortest first', () => {
    expect(offers(PLANS, 'burn')).toEqual([{ plan: 'hour', hours: 1, amount: 100_000n * M }, { plan: 'week', hours: 168, amount: 7_500_000n * M }]);
    expect(offers(PLANS, 'usdc').map((o) => o.plan)).toEqual(['week', 'month']);
  });

  it('follow a changed price or a dropped plan with no client change', () => {
    const changed = PLANS.map((p) => (p.plan === 'hour' ? { ...p, amount: String(1n * M) } : p));
    expect(offers(changed, 'burn')[0].amount).toBe(1n * M);
    expect(offers(PLANS.filter((p) => p.plan !== 'hour'), 'burn').map((o) => o.plan)).toEqual(['week']);
    expect(offers([], 'burn')).toEqual([]);
  });

  it('before the board loads, show names with no price, so nothing hardcoded can be charged', () => {
    for (const m of ['burn', 'usdc'] as const) for (const o of offers(null, m)) expect(o.amount).toBeNull();
    expect(offers(undefined, 'usdc').map((o) => o.plan)).toEqual(['week', 'month']);
  });

  it('ignore a row it cannot read', () => {
    expect(offers([{ method: 'burn', plan: 'year' as never, hours: 1, amount: '5' }, { method: 'burn', plan: 'day', hours: 24, amount: 'x' }], 'burn')).toEqual([]);
    expect(isPlan('month')).toBe(true);
    expect(isPlan('year')).toBe(false);
  });

  it('keep a pick that is on offer, and otherwise pick one that is', () => {
    const burn = offers(PLANS, 'burn');
    expect(pickPlan(burn, 'week')).toBe('week');
    expect(pickPlan(burn, 'day')).toBe('hour');
    expect(pickPlan([], 'day')).toBe('day');
  });

  it('work out what a longer plan saves against the shortest', () => {
    const burn = offers(PLANS, 'burn');
    expect(planBadges(0, false)).toBe('');
    expect(planBadges(55, true)).toBe('<span class="ad-badges"><span class="ad-badge best">Best value</span><span class="ad-badge save">Save 55%</span></span>');
    expect(planBadges(37, false)).toBe('<span class="ad-badges"><span class="ad-badge save">Save 37%</span></span>');
    expect(planBadges(55, true)).not.toContain('Best value ·');
    expect(savePercent(burn[0], burn)).toBe(0);
    expect(savePercent(burn[1], burn)).toBe(55);
    const usdc = offers(PLANS, 'usdc');
    expect(savePercent(usdc[1], usdc)).toBe(22);
    expect(savePercent({ plan: 'week', hours: 168, amount: null }, burn)).toBe(0);
  });
});

describe('ticker and combo ads', () => {
  it('are DM-only: listed with their contacts, with no way to check out', () => {
    expect(DM_ONLY.map((d) => d.name)).toEqual(['Ticker ad', 'Ticker + courtside combo']);
    expect(DM_ONLY.map((d) => d.prices).join(' ')).toMatch(/\$75.*\$250.*\$650/);
    expect(DM_CONTACTS.map((c) => c.href)).toEqual(['https://x.com/pokejamsol', 'https://t.me/PokeJamSol']);
    const at = screenSource.indexOf('data-dm-only');
    const section = screenSource.slice(at, screenSource.indexOf('</section>', at));
    expect(section).toMatch(/paid in SOL/);
    expect(section).not.toMatch(/data-plan|data-a=|data-wallet/);
  });
});

describe('the page holds no prices of its own', () => {
  it('has no price constants in the client', () => {
    for (const source of [screenSource, usdcSource, apiSource, plansSource]) {
      const code = source.replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/100_?000_?000_?000|1_?500_?000_?000_?000|7_?500_?000_?000_?000|150_?000_?000|500_?000_?000/);
    }
    expect(usdcSource).not.toMatch(/week: 150|month: 500/);
  });
});
