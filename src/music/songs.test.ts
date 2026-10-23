import { describe, expect, it } from 'vitest';
import { SONGS, hz, loopNotes } from './songs';
import { MENU_VARIANTS, menuPlaylist } from './menuSongs';
import { Playlist } from './music';
import { trackFor } from './music';

describe('background music', () => {
  it('tunes notes to A440', () => {
    expect(hz('A4')).toBeCloseTo(440);
    expect(hz('C5')).toBeCloseTo(523.25, 1);
    expect(hz('G#3')).toBeCloseTo(207.65, 1);
  });

  for (const s of [...Object.values(SONGS), ...Object.values(MENU_VARIANTS)]) {
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

  it('menu playlist: all four tracks, 16 bars or more, ?menu= pins one', () => {
    const all = menuPlaylist(null);
    expect(all.map((x) => x.title)).toEqual(['Attract Mode', 'Route Bop', 'Jam Session', 'Fast Break Route']);
    for (const v of all) expect(v.melody.length).toBeGreaterThanOrEqual(16);
    expect(menuPlaylist('jam')).toEqual([MENU_VARIANTS.jam]);
    expect(menuPlaylist('nope')).toHaveLength(4);
  });

  it('rotation starts anywhere and never repeats a track back to back', () => {
    const songs = menuPlaylist(null);
    const starts = new Set([0, 0.3, 0.6, 0.9].map((r) => new Playlist(songs, () => r).current.title));
    expect(starts.size).toBe(4);
    const p = new Playlist(songs);
    const seen = new Set<string>();
    let prev = p.current.title;
    for (let i = 0; i < 200; i++) {
      const next = p.advance().title;
      expect(next).not.toBe(prev);
      seen.add(next);
      prev = next;
    }
    expect(seen.size).toBe(4);
    expect(new Playlist([songs[0]]).advance()).toBe(songs[0]);
  });

  it('picks a track per screen and stays quiet in games', () => {
    expect(trackFor('screen-menu')).toBe('menu');
    expect(trackFor('screen-quick')).toBe('menu');
    expect(trackFor('screen-roster')).toBe('menu');
    expect(trackFor('screen-draft')).toBe('draft');
    expect(trackFor('screen-hub')).toBe('menu');
    expect(trackFor('screen-season')).toBe('menu');
    expect(trackFor('screen-results')).toBe('menu');
    expect(trackFor('screen-game')).toBeNull();
  });
});
