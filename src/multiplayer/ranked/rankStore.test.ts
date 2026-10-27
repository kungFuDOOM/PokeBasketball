import { describe, expect, it } from 'vitest';
import { LocalRankStore } from './rankStore';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe('LocalRankStore', () => {
  it('persists ranked results', () => {
    const s = new LocalRankStore(mem());
    s.apply(1000, true);
    expect(s.get().placements).toBe(1);
    expect(s.mmr()).toBeGreaterThan(1000);
  });
});
