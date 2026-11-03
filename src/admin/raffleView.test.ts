import { describe, expect, it } from 'vitest';
import { raffleHtml, type RaffleAdmin } from './raffleView';

const base = (over: Partial<RaffleAdmin> = {}): RaffleAdmin => ({
  which: 'previous', week_start: '2026-10-26', resets_at: '2026-11-02T08:00:00.000Z', open: false,
  entrants: [{ user_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Ash', wallet: '5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p', offline: 3, online: 3, online_wins: 1, social: 1, rank_steps: 1, zenith: false, grind: 0, holder: 0, entries: 1 }],
  draw: null, ...over,
});

describe('raffle admin', () => {
  it('lists entrants and offers a draw only after the week closes', () => {
    const closed = raffleHtml(base());
    expect(closed).toContain('data-raffle="draw"');
    expect(closed).toContain('data-week="2026-10-26"');
    expect(closed).toContain('at draw');
    expect(closed).toContain('Ash');
    expect(closed).toContain('5nji…q16p');
    expect(closed).not.toContain('5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p</');
    const open = raffleHtml(base({ open: true, which: 'current' }));
    expect(open).not.toContain('data-raffle="draw"');
    expect(open).toContain('Still open');
  });

  it('shows the stored winner and escapes the name', () => {
    const html = raffleHtml(base({
      entrants: [],
      draw: {
        winner_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', winner_name: '<b>nope</b>', total_entries: 4,
        seed: 'aa', ticket: 1, algorithm: 'uint64be-mod-v1',
        snapshot: { entrants: [{ user_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: '<b>nope</b>', wallet: null, offline: 3, online: 3, online_wins: 1, social: 1, rank_steps: 1, zenith: false, grind: 0, holder: 2, entries: 3 }] },
      },
    }));
    expect(html).toContain('Winner');
    expect(html).toContain('&lt;b&gt;nope&lt;/b&gt;');
    expect(html).not.toContain('<b>nope</b>');
    expect(html).toContain('uint64be-mod-v1');
    expect(html).toContain('>2<');
    expect(html).not.toContain('data-raffle="draw"');
  });
});
