import { describe, expect, it } from 'vitest';
import { SONGS, hz, loopNotes } from './songs';
import { trackFor } from './music';

describe('background music', () => {
  it('tunes notes to A440', () => {
    expect(hz('A4')).toBeCloseTo(440);
    expect(hz('C5')).toBeCloseTo(523.25, 1);
    expect(hz('G#3')).toBeCloseTo(207.65, 1);
  });

  for (const s of Object.values(SONGS)) {
    it(`${s.title} is a whole number of bars that loops cleanly`, () => {
      const { steps, notes } = loopNotes(s);
      expect(s.chords).toHaveLength(s.melody.length);
      expect(steps % 8).toBe(0);
      expect(notes.length).toBeGreaterThan(0);
      // Nothing rings past the loop point, so the loop restarts seamlessly.
      for (const n of notes) expect(n.step + n.len).toBeLessThanOrEqual(steps);
      for (const n of notes) expect(Number.isFinite(n.freq)).toBe(true);
    });
  }

  it('picks a track per screen and stays quiet in games', () => {
    expect(trackFor('screen-menu')).toBe('menu');
    expect(trackFor('screen-quick')).toBe('menu');
    expect(trackFor('screen-roster')).toBe('menu');
    expect(trackFor('screen-draft')).toBe('draft');
    expect(trackFor('screen-hub')).toBe('season');
    expect(trackFor('screen-season')).toBe('season');
    expect(trackFor('screen-results')).toBe('season');
    expect(trackFor('screen-game')).toBeNull();
  });
});
