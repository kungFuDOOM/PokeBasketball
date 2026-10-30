import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Mon } from '../data/pokemon';
import type { TeamDef } from '../game/types';
import { withIntro } from './intro';
import {
  INTRO_CAP_MS, INTRO_LEN_MS, INTRO_QUICK_LEN_MS, IntroVotes, introEnabled, introLength, isIntroMode,
  type IntroCtx, type IntroMode,
} from './intro.logic';

const CTXS: IntroCtx[] = ['ranked', 'social', 'quick', 'cpu', 'franchise'];

describe('introEnabled', () => {
  it('follows the mode x ctx matrix', () => {
    for (const ctx of CTXS) {
      expect(introEnabled('full', ctx)).toBe(true);
      expect(introEnabled('quick', ctx)).toBe(true);
      expect(introEnabled('off', ctx)).toBe(ctx === 'ranked' || ctx === 'social');
    }
  });
});

describe('introLength', () => {
  it('offline games run 6 s with instant skip', () => {
    for (const ctx of ['quick', 'cpu', 'franchise'] as IntroCtx[]) {
      expect(introLength(ctx, false)).toEqual({ lengthMs: INTRO_LEN_MS, capMs: INTRO_LEN_MS, instantSkip: true });
    }
  });
  it('offline quick mode is shorter, but not for ranked/social', () => {
    expect(introLength('cpu', false, 'quick').lengthMs).toBe(INTRO_QUICK_LEN_MS);
    expect(introLength('ranked', false, 'quick').lengthMs).toBe(INTRO_LEN_MS);
  });
  it('online games run 6 s, capped at 10 s, no instant skip', () => {
    for (const ctx of CTXS) {
      for (const mode of ['full', 'quick', 'off'] as IntroMode[]) {
        const t = introLength(ctx, true, mode);
        expect(t).toEqual({ lengthMs: 6000, capMs: 10000, instantSkip: false });
        expect(t.lengthMs).toBeLessThanOrEqual(INTRO_CAP_MS);
      }
    }
  });
});

describe('IntroVotes', () => {
  it('tracks votes and labels each state', () => {
    const v = new IntroVotes();
    expect(v.both()).toBe(false);
    expect(v.label()).toBe('Skip');
    v.vote('theirs', true);
    expect(v.label()).toBe('1/2 ready');
    v.vote('theirs', false);
    v.vote('mine', true);
    expect(v.label()).toBe('Waiting for opponent');
    expect(v.both()).toBe(false);
    v.vote('theirs', true);
    expect(v.both()).toBe(true);
    expect(v.label()).toBe('2/2 ready');
    v.vote('mine', false);
    expect(v.both()).toBe(false);
    expect(v.label()).toBe('1/2 ready');
  });
});

describe('isIntroMode', () => {
  it('accepts only the three modes', () => {
    expect(['full', 'quick', 'off'].every(isIntroMode)).toBe(true);
    expect(isIntroMode('none')).toBe(false);
    expect(isIntroMode(1)).toBe(false);
  });
});

describe('withIntro wiring', () => {
  // No DOM in these tests: a fake root with just what showIntro touches.
  const fakeRoot = () => {
    const btn = { textContent: '', setAttribute() {}, addEventListener() {}, classList: { toggle() {} } };
    return { className: '', innerHTML: '', querySelector: () => btn } as unknown as HTMLElement;
  };
  const mon = { dex: 25, name: 'Pikachu', pos: 'PG', ovr: 80 } as unknown as Mon;
  const team = (name: string): TeamDef => ({ name, abbr: 'ABC', color: '#f00', color2: '#fff', human: true, roster: [mon, mon, mon, mon, mon] });
  const cfg = { home: team('Home'), away: team('Away') };

  beforeAll(() => {
    // spriteUrl reads window.__POKE_SPRITES.
    (globalThis as { window?: unknown }).window ??= {};
  });

  it('off: calls then synchronously with no intro', () => {
    const then = vi.fn();
    expect(withIntro(fakeRoot(), cfg, 'quick', { introMode: 'off' }, then)).toBeNull();
    expect(then).toHaveBeenCalledTimes(1);
  });

  it('on: calls then only after finishNow, leaving screen-game', async () => {
    const root = fakeRoot();
    const then = vi.fn();
    const h = withIntro(root, cfg, 'franchise', { introMode: 'full' }, then)!;
    expect(root.className).toBe('screen-intro');
    await Promise.resolve();
    expect(then).not.toHaveBeenCalled();
    h.finishNow();
    await h.done;
    await Promise.resolve();
    expect(then).toHaveBeenCalledTimes(1);
    expect(root.className).toBe('screen-game');
  });

  it('off never skips Ranked; destroy cancels the game start', async () => {
    const then = vi.fn();
    const h = withIntro(fakeRoot(), cfg, 'ranked', { introMode: 'off' }, then)!;
    expect(h).not.toBeNull();
    h.destroy();
    h.finishNow();
    await Promise.resolve();
    expect(then).not.toHaveBeenCalled();
  });
});
