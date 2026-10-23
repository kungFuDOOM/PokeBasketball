/**
 * Original chiptune loops for the background music. Written for PokéJam, not taken from any game:
 * mellow, Game Boy-style parts (pulse lead, soft pulse arpeggio, triangle bass, light noise hats).
 *
 * Each bar is 8 eighth-note steps. In a melody bar a note name starts a note, `-` holds the previous
 * one and `.` is a rest.
 */
export interface Song {
  id: TrackId;
  title: string;
  bpm: number;
  /** 0 = straight eighths, ~0.15 = lazy swing. */
  swing: number;
  /** One chord per bar, low to high (used for the arpeggio and the bass). */
  chords: string[][];
  melody: string[];
  /** Bass rhythm per bar: R = root, F = fifth, O = root up an octave, - = hold, . = rest. */
  bass: string;
  /** Arpeggio pattern per bar: chord-tone indexes, `.` = rest. */
  arp: string;
  /** Hat and kick pattern per bar: k = soft kick, h = hat, . = nothing. */
  drums: string;
}

export type TrackId = 'menu' | 'draft' | 'season';

const ch = (s: string) => s.split(' ');

export const SONGS: Record<TrackId, Song> = {
  // Title screen, Quick Play setup and the roster: an easy-going walk to the gym.
  menu: {
    id: 'menu',
    title: 'Pallet Court',
    bpm: 86,
    swing: 0.14,
    chords: [
      ch('F3 A3 C4 E4'), ch('E3 G3 B3 D4'), ch('D3 F3 A3 C4'), ch('G3 B3 D4 F4'),
      ch('F3 A3 C4 E4'), ch('E3 G3 B3 D4'), ch('D3 F3 A3 C4'), ch('G3 B3 D4 F4'),
    ],
    melody: [
      'A4 - C5 - E5 - D5 C5',
      'B4 - G4 - . . E4 G4',
      'A4 - - C5 F5 - E5 D5',
      'D5 - - - . . B4 C5',
      'A4 - C5 - E5 - G5 -',
      'F5 E5 D5 - B4 - G4 -',
      'A4 - F4 A4 C5 - D5 -',
      'B4 - - - . . . .',
    ],
    bass: 'R - - F O - F -',
    arp: '0 1 2 3 2 1 2 1',
    drums: 'k . h . . k h .',
  },
  // Draft boards (Quick Play, Season, Franchise and the rookie draft): a little more bounce.
  draft: {
    id: 'draft',
    title: 'Draft Day',
    bpm: 100,
    swing: 0.08,
    chords: [
      ch('A3 C4 E4 G4'), ch('F3 A3 C4 E4'), ch('C3 E3 G3 B3'), ch('G3 B3 D4 G4'),
      ch('A3 C4 E4 G4'), ch('F3 A3 C4 E4'), ch('D3 F3 A3 C4'), ch('E3 G#3 B3 D4'),
    ],
    melody: [
      'E5 . E5 G5 A5 - G5 E5',
      'F5 - E5 - C5 - A4 -',
      'G4 . G4 C5 E5 - D5 C5',
      'D5 - - - B4 - G4 -',
      'E5 . E5 G5 A5 - C6 B5',
      'A5 - G5 - F5 E5 C5 -',
      'D5 - F5 - A5 - G5 F5',
      'E5 - - - G#4 - B4 -',
    ],
    bass: 'R . R F O . F R',
    arp: '0 2 1 3 0 2 1 3',
    drums: 'k h . h k h . h',
  },
  // Franchise hub, Season results and box scores: slow, warm, late-evening.
  season: {
    id: 'season',
    title: 'Evening League',
    bpm: 78,
    swing: 0.16,
    chords: [
      ch('G3 B3 D4 F#4'), ch('F#3 A3 C#4 E4'), ch('E3 G3 B3 D4'), ch('A3 C#4 E4 G4'),
      ch('G3 B3 D4 F#4'), ch('F#3 A3 C#4 E4'), ch('B3 D4 F#4 A4'), ch('A3 C#4 E4 G4'),
    ],
    melody: [
      'F#5 - - E5 D5 - B4 -',
      'C#5 - A4 - . . F#4 A4',
      'B4 - D5 - G5 - F#5 E5',
      'E5 - - - . C#5 D5 E5',
      'F#5 - A5 - G5 F#5 D5 -',
      'E5 - C#5 - A4 - . .',
      'D5 - F#5 - B5 - A5 F#5',
      'A5 - G5 - E5 - C#5 -',
    ],
    bass: 'R - . F R - O -',
    arp: '0 1 2 3 . 2 1 .',
    drums: 'k . h . k . h h',
  },
};

const NOTE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C#4" -> Hz (A4 = 440). */
export function hz(name: string): number {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  const semi = NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
  return 440 * 2 ** ((semi - 69) / 12);
}

export type Voice = 'lead' | 'arp' | 'bass' | 'kick' | 'hat';
export interface NoteEv { step: number; len: number; voice: Voice; freq: number }

/** Every note of one loop, as steps (eighth notes) from the loop start. Pure, so it can be tested. */
export function loopNotes(s: Song): { steps: number; notes: NoteEv[] } {
  const notes: NoteEv[] = [];
  const bars = s.melody.length;
  s.melody.forEach((bar, b) => {
    const toks = bar.split(' ');
    if (toks.length !== 8) throw new Error(`${s.id} bar ${b + 1} needs 8 steps`);
    toks.forEach((t, i) => {
      const step = b * 8 + i;
      if (t === '-') {
        const last = notes[notes.length - 1];
        if (last && last.voice === 'lead' && last.step + last.len === step) last.len++;
      } else if (t !== '.') notes.push({ step, len: 1, voice: 'lead', freq: hz(t) });
    });
  });
  for (let b = 0; b < bars; b++) {
    const chord = s.chords[b].map(hz);
    const root = chord[0] / 2;
    const fifth = root * 1.5;
    s.bass.split(' ').forEach((t, i) => {
      const step = b * 8 + i;
      if (t === '-') {
        const last = notes[notes.length - 1];
        if (last && last.voice === 'bass' && last.step + last.len === step) last.len++;
      } else if (t !== '.') notes.push({ step, len: 1, voice: 'bass', freq: t === 'F' ? fifth : t === 'O' ? root * 2 : root });
    });
    s.arp.split(' ').forEach((t, i) => {
      if (t !== '.') notes.push({ step: b * 8 + i, len: 1, voice: 'arp', freq: chord[Number(t)] * 2 });
    });
    s.drums.split(' ').forEach((t, i) => {
      if (t === 'k') notes.push({ step: b * 8 + i, len: 1, voice: 'kick', freq: 110 });
      else if (t === 'h') notes.push({ step: b * 8 + i, len: 1, voice: 'hat', freq: 0 });
    });
  }
  return { steps: bars * 8, notes: notes.sort((a, b) => a.step - b.step) };
}
