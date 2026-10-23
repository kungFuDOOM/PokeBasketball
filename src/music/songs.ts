/**
 * Original chiptune loops for the background music. Written for PokéJam, not taken from any game:
 * Game Boy-style parts (pulse lead, pulse arpeggio, triangle or slap bass, synthesized drums).
 *
 * A bar is `steps` steps long (8 eighth notes unless the song says 16). Any part's bar may be written with
 * fewer tokens than steps (8 tokens on a 16-step grid = eighth notes); each token then spans the rest.
 * In a melody bar a note name starts a note, `-` holds the previous one and `.` is a rest.
 * A part given as an array has one pattern per bar (cycled); a single string repeats every bar.
 */
import { MENU_VARIANTS } from './menuSongs';

export interface Song {
  id: TrackId;
  title: string;
  bpm: number;
  /** Steps per bar: 8 (eighth notes, the default) or 16 (sixteenths). */
  steps?: 8 | 16;
  /** Swing on the off-steps: 0 = straight, ~0.15 = lazy. */
  swing: number;
  /** One chord per bar, low to high (used for the arpeggio, stabs and the bass). */
  chords: string[][];
  melody: string[];
  /** Bass rhythm: R = root, F = fifth, O = root up an octave, S = flat seventh, a note name ("A2"), - = hold, . = rest. */
  bass: string | string[];
  /** Bass sound: soft triangle (default) or a funky slap. */
  bassVoice?: 'tri' | 'slap';
  /** Arpeggio pattern: chord-tone indexes, `.` = rest. */
  arp: string | string[];
  /**
   * Drums, one token per slot, letters combine ("Kh" = kick and hat): k = soft kick, K = punchy kick,
   * s = snare, n = rounder snare, g = ghost snare, h = closed hat, o = open hat, . = nothing.
   */
  drums: string | string[];
  /** Chord stabs (call and response): x = stab, . = nothing. */
  stabs?: string | string[];
  /** Low-pass on the whole track, in Hz (default 3400, mellow). */
  cutoff?: number;
  /** Echo time on the lead, in beats (default 1.5). */
  echoBeats?: number;
  /** High-pass on the track in Hz, to keep sub lows off phone speakers (default none). */
  lowCut?: number;
  /** Drum bus level relative to the melody (default 1). */
  drumLevel?: number;
  /** Drums bypass the track's low-pass (crisper hats, still low-cut). */
  crispDrums?: boolean;
  /** Bass level relative to the melody (default 1). */
  bassLevel?: number;
  /** Lead sound: Game Boy pulse (default) or a wobbly, filtered synth lead. */
  leadVoice?: 'pulse' | 'wobble';
  /** Doubles the lead with synth brass an octave down (the big arcade hook). */
  brassDouble?: boolean;
  /** Electric piano chord hits: x = play the bar's chord. */
  keys?: string | string[];
}

/** 'menu' is the menu and franchise screens' playlist (menuSongs.ts); 'draft' is every draft board. */
export type TrackId = 'menu' | 'draft';

const ch = (s: string) => s.split(' ');

export const SONGS: Record<TrackId, Song> = {
  // Menu and franchise screens rotate through MENU_PLAYLIST (see Music); this is the first track, used for previews.
  menu: MENU_VARIANTS.hype,
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
};

const NOTE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C#4" -> Hz (A4 = 440). */
export function hz(name: string): number {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  const semi = NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
  return 440 * 2 ** ((semi - 69) / 12);
}

export type Voice = 'lead' | 'wobble' | 'brass' | 'ep' | 'arp' | 'bass' | 'slap' | 'kick' | 'punch' | 'snare' | 'snap' | 'ghost' | 'hat' | 'ohat' | 'stab';
export interface NoteEv { step: number; len: number; voice: Voice; freq: number }

const DRUM: Record<string, Voice> = { k: 'kick', K: 'punch', s: 'snare', n: 'snap', g: 'ghost', h: 'hat', o: 'ohat' };

/** Every note of one loop, as steps from the loop start. Pure, so it can be tested. */
export function loopNotes(s: Song): { steps: number; notes: NoteEv[] } {
  const per = s.steps ?? 8;
  const notes: NoteEv[] = [];
  const bars = s.melody.length;
  const barOf = (part: string | string[] | undefined, b: number) =>
    part === undefined ? [] : (typeof part === 'string' ? part : part[b % part.length]).split(' ');
  /** Walks one bar of a part: `on(token, step, span)` for each token; `-` extends the last note of `voice`. */
  const walk = (toks: string[], b: number, voice: Voice | null, on: (t: string, step: number, span: number) => void) => {
    if (!toks.length) return;
    if (per % toks.length) throw new Error(`${s.id} bar ${b + 1}: ${toks.length} tokens don't fit ${per} steps`);
    const span = per / toks.length;
    toks.forEach((t, i) => {
      const step = b * per + i * span;
      if (t === '-' && voice) {
        const last = [...notes].reverse().find((n) => n.voice === voice);
        if (last && last.step + last.len === step) last.len += span;
      } else if (t !== '.' && t !== '-') on(t, step, span);
    });
  };
  for (let b = 0; b < bars; b++) {
    const chord = s.chords[b].map(hz);
    const root = chord[0] / 2;
    const lv: Voice = s.leadVoice === 'wobble' ? 'wobble' : 'lead';
    walk(s.melody[b].split(' '), b, lv, (t, step, len) => notes.push({ step, len, voice: lv, freq: hz(t) }));
    const bv: Voice = s.bassVoice === 'slap' ? 'slap' : 'bass';
    walk(barOf(s.bass, b), b, bv, (t, step, len) => notes.push({
      step, len, voice: bv,
      freq: t === 'F' ? root * 1.5 : t === 'O' ? root * 2 : t === 'S' ? root * 2 ** (10 / 12) : t === 'R' ? root : hz(t),
    }));
    walk(barOf(s.arp, b), b, null, (t, step, len) => notes.push({ step, len, voice: 'arp', freq: chord[Number(t)] * 2 }));
    walk(barOf(s.drums, b), b, null, (t, step, len) => {
      for (const c of t) {
        const v = DRUM[c];
        if (!v) throw new Error(`${s.id} bar ${b + 1}: bad drum ${c}`);
        notes.push({ step, len, voice: v, freq: v === 'kick' ? 110 : 0 });
      }
    });
    walk(barOf(s.stabs, b), b, null, (_t, step, len) => {
      for (const f of chord.slice(1)) notes.push({ step, len, voice: 'stab', freq: f * 2 });
    });
    walk(barOf(s.keys, b), b, null, (_t, step, len) => {
      for (const f of chord) notes.push({ step, len, voice: 'ep', freq: f });
    });
  }
  if (s.brassDouble) {
    for (const n of notes.filter((x) => x.voice === 'lead')) notes.push({ ...n, voice: 'brass', freq: n.freq / 2 });
  }
  return { steps: bars * per, notes: notes.sort((a, b) => a.step - b.step) };
}
