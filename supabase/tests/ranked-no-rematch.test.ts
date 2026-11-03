// Ranked has no rematch path: the results screen routes to a fresh search, and the wire protocol is unchanged.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(`../../src/multiplayer/shared/${rel}`, import.meta.url), 'utf8');

describe('Ranked results wiring', () => {
  it('the game screen routes the Ranked button to a fresh search and ignores a Ranked "again"', () => {
    const src = read('onlineGame.ts');
    expect(src).toContain('onlineResultsButtons(match.queue)');
    expect(src).toMatch(/a === 'find-ranked' && match\.queue === 'ranked'/);
    expect(src).toMatch(/a === 'again' && match\.queue !== 'ranked'/);
  });

  it('the wire protocol has no rematch message (nothing to accept or decline), and NET_VERSION stays 3', () => {
    const net = read('netplay.ts');
    expect(net).not.toMatch(/rematch/i);
    expect(net).toMatch(/NET_VERSION = 3;/);
  });
});
