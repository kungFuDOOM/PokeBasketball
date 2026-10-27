import { describe, expect, it } from 'vitest';
import { LocalMockMatchService, type RatingStore } from './matchService';
import { ENGINE_VERSION } from '../../game/types';

const opp = { id: 'x', name: 'CPU', mmr: 1000, simulated: true };
const fake = (): RatingStore & { calls: number } => ({ calls: 0, mmr: () => 1000, apply() { this.calls++; return 'ok'; } });

describe('LocalMockMatchService', () => {
  it('ranked results go to the rating store', async () => {
    const r = fake();
    const o = await new LocalMockMatchService(r).reportResult('ranked', opp, { won: true, score: [50, 40], engineVersion: ENGINE_VERSION });
    expect(o.rank).toBe('ok');
    expect(r.calls).toBe(1);
  });
  it('social results never touch ratings', async () => {
    const r = fake();
    const o = await new LocalMockMatchService(r).reportResult('social', opp, { won: true, score: [50, 40], engineVersion: ENGINE_VERSION });
    expect(o.rank).toBeUndefined();
    expect(r.calls).toBe(0);
  });
});
