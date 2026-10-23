import type { Song } from './songs';

/**
 * The menu playlist, "NBA Jam mixed with Pokémon". All original: no melodies, riffs or samples
 * from either game. Every one is mixed for phone speakers: the drums sit on their own lower bus, the low end is
 * rolled off below 80 Hz, and the hook leads. Each is a 16-bar loop built on a 2-bar hook (Fast Break Route
 * has 2-bar call-and-response phrases).
 */
const ch = (s: string) => s.split(' ');
const rep = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x);
const NONE = '. . . . . . . .';

// ---------- A) Hype: 90s arcade attract mode. Synth brass hook doubled by a Game Boy lead. ----------
const hypeGroove = 'Kh . h . nh . h . Kh . h K nh . h .';
const hypeFill = 'Kh . h . nh . h . Kh . n . n g n n';
export const HYPE: Song = {
  id: 'menu',
  title: 'Attract Mode',
  bpm: 118,
  steps: 16,
  swing: 0,
  cutoff: 6000,
  echoBeats: 0.75,
  lowCut: 80,
  crispDrums: true,
  drumLevel: 0.9,
  bassLevel: 0.75,
  bassVoice: 'slap',
  brassDouble: true,
  chords: [
    ch('D3 F#3 A3 D4'), ch('C3 E3 G3 C4'), ch('D3 F#3 A3 D4'), ch('A3 C#4 E4 A4'),
    ch('D3 F#3 A3 D4'), ch('C3 E3 G3 C4'), ch('D3 F#3 A3 D4'), ch('A3 C#4 E4 A4'),
    ch('B3 D4 F#4 B4'), ch('G3 B3 D4 G4'), ch('D3 F#3 A3 D4'), ch('A3 C#4 E4 A4'),
    ch('B3 D4 F#4 B4'), ch('G3 B3 D4 G4'), ch('A3 C#4 E4 A4'), ch('A3 C#4 E4 A4'),
  ],
  melody: [
    // The hook (bars 1-2), answered (3-4), then again with a lift into the B section.
    'A4 . D5 . F#5 - E5 D5', 'E5 - C5 . G5 - - .',
    'A4 . D5 . F#5 - A5 F#5', 'E5 - - - C#5 - . .',
    'A4 . D5 . F#5 - E5 D5', 'E5 - C5 . G5 - - .',
    'A4 . D5 . F#5 - A5 B5', 'A5 - - - . . . .',
    'F#5 - D5 - B4 - D5 F#5', 'G5 - - - B5 - A5 G5',
    'F#5 - A5 - D6 - A5 -', 'C#6 - B5 - A5 - E5 -',
    'D6 - C#6 - B5 - F#5 -', 'G5 - B5 - D6 - B5 -',
    'C#6 - - - E6 - - -', 'C#6 - B5 A5 E5 - . .',
  ],
  bass: [...rep(15, 'R O R O R O R F'), 'R O R O F O S O'],
  arp: [...rep(8, NONE), ...rep(8, '0 1 2 3 0 1 2 3 0 1 2 3 0 1 2 3')],
  drums: [...rep(7, hypeGroove), hypeFill, ...rep(7, hypeGroove), hypeFill],
};

// ---------- B) Route Bop: a bright adventure-town melody over a light break and a walking bass. ----------
const bopGroove = 'Kh . h . nh . h K . . Kh . nh . h .';
const bopGroove2 = 'Kh . h . nh . h . Kh . h K nh . h g';
const bopFill = 'Kh . h . nh . h . Kh . h . n g n n';
export const ROUTE: Song = {
  id: 'menu',
  title: 'Route Bop',
  bpm: 100,
  steps: 16,
  swing: 0.12,
  cutoff: 5500,
  lowCut: 80,
  crispDrums: true,
  drumLevel: 0.85,
  bassLevel: 0.55,
  chords: [
    ch('C3 E3 G3 C4'), ch('A3 C4 E4 A4'), ch('F3 A3 C4 F4'), ch('G3 B3 D4 G4'),
    ch('C3 E3 G3 C4'), ch('A3 C4 E4 A4'), ch('D3 F3 A3 D4'), ch('G3 B3 D4 G4'),
    ch('F3 A3 C4 F4'), ch('G3 B3 D4 G4'), ch('E3 G3 B3 E4'), ch('A3 C4 E4 A4'),
    ch('F3 A3 C4 F4'), ch('G3 B3 D4 G4'), ch('C3 E3 G3 C4'), ch('G3 B3 D4 F4'),
  ],
  melody: [
    // The hook (bars 1-2): a hop up the major chord and a skip back down.
    'G4 C5 E5 . G5 - E5 C5', 'A5 - G5 - E5 - . .',
    'F5 E5 F5 . A5 - G5 F5', 'D5 - - - . . G4 .',
    'G4 C5 E5 . G5 - E5 C5', 'A5 - G5 - E5 - C6 .',
    'B5 A5 G5 . F5 - E5 D5', 'C5 - - - . . . .',
    'A5 - C6 - A5 - F5 -', 'G5 - B5 - D6 - B5 -',
    'G5 - E5 - B4 - E5 G5', 'A5 - - - C6 - B5 A5',
    'A5 - F5 - C5 - F5 A5', 'B5 - G5 - D5 - G5 B5',
    'C6 - - - G5 - E5 -', 'D5 - F5 - B5 - G5 .',
  ],
  // Walking bass, one note per beat.
  bass: [
    'C3 E3 G3 B2', 'A2 C3 E3 G2', 'F2 A2 C3 F#2', 'G2 B2 D3 B2',
    'C3 E3 G3 B2', 'A2 C3 E3 C3', 'D3 F3 A3 F#3', 'G2 B2 D3 G2',
    'F2 A2 C3 A2', 'G2 B2 D3 B2', 'E2 G2 B2 G2', 'A2 C3 E3 C3',
    'F2 A2 C3 A2', 'G2 B2 D3 B2', 'C3 G2 E3 G2', 'G2 B2 D3 F3',
  ],
  arp: [...rep(8, '0 . 2 . 1 . 3 .'), ...rep(8, '0 1 2 3 2 1 2 3')],
  drums: [bopGroove, bopGroove2, bopGroove, bopGroove2, bopGroove, bopGroove2, bopGroove, bopFill,
    bopGroove, bopGroove2, bopGroove, bopGroove2, bopGroove, bopGroove2, bopGroove, bopFill],
};

// ---------- C) Jam Session: laid-back G-funk / new jack swing. Wobbly lead, electric piano, chip arps. ----------
const jamGroove = 'Kh . h . nh . h g . Kh h . nh . o .';
const jamGroove2 = 'Kh . h . nh . h . Kh . h K nh g h .';
const jamComp = '. . . . x . . . . . x . . . . .';
export const JAM: Song = {
  id: 'menu',
  title: 'Jam Session',
  bpm: 95,
  steps: 16,
  swing: 0.2,
  cutoff: 4500,
  echoBeats: 0.75,
  lowCut: 80,
  crispDrums: true,
  drumLevel: 0.85,
  bassLevel: 0.65,
  leadVoice: 'wobble',
  chords: [
    ch('E3 G3 B3 D4'), ch('A3 C#4 E4 G4'), ch('E3 G3 B3 D4'), ch('A3 C#4 E4 G4'),
    ch('E3 G3 B3 D4'), ch('A3 C#4 E4 G4'), ch('C3 E3 G3 B3'), ch('B3 D#4 F#4 A4'),
    ch('A3 C4 E4 G4'), ch('D3 F#3 A3 C4'), ch('G3 B3 D4 F#4'), ch('C3 E3 G3 B3'),
    ch('A3 C4 E4 G4'), ch('D3 F#3 A3 C4'), ch('C3 E3 G3 B3'), ch('B3 D#4 F#4 A4'),
  ],
  melody: [
    // The hook (bars 1-2): a lazy climb that falls back onto the A7.
    'B4 - D5 E5 - - G5 -', 'F#5 - E5 - C#5 - . .',
    'B4 - D5 E5 - - B5 -', 'A5 - G5 - E5 - . .',
    'B4 - D5 E5 - - G5 -', 'F#5 - E5 - C#5 - . .',
    'G5 - E5 - B4 - C5 -', 'D#5 - - - F#5 - - .',
    'E5 - - - C5 - E5 G5', 'F#5 - - - A5 - F#5 -',
    'D5 - - - B4 - D5 F#5', 'E5 - - - - - . .',
    'C5 - E5 - A5 - G5 E5', 'F#5 - A5 - C6 - B5 A5',
    'G5 - - - E5 - B4 -', 'D#5 - F#5 - A5 - F#5 -',
  ],
  bass: [...rep(15, 'R - - . . . O . R - . F . . S .'), 'R - - . . . O . F - . O . . R .'],
  arp: [...rep(6, NONE), ...rep(2, '0 1 2 3 1 2 3 0 0 1 2 3 1 2 3 0'), ...rep(4, NONE), ...rep(4, '0 1 2 3 1 2 3 0 0 1 2 3 1 2 3 0')],
  keys: jamComp,
  drums: [...rep(7, jamGroove).map((g, i) => (i % 2 ? jamGroove2 : g)), 'Kh . h . nh . h g Kh . h . n g n .',
    ...rep(7, jamGroove).map((g, i) => (i % 2 ? jamGroove2 : g)), 'Kh . h . nh . h g Kh . n g n . o .'],
};


// ---------- D) Fast Break Route (the previous menu track, phone-friendly mix from #28). ----------
export const FASTBREAK: Song = {
  id: 'menu',
  title: 'Fast Break Route',
  bpm: 110,
  steps: 16,
  swing: 0.1,
  cutoff: 7500,
  echoBeats: 0.75,
  lowCut: 80,
  drumLevel: 0.75,
  bassVoice: 'slap',
  chords: [
    ch('G3 B3 D4 F4'), ch('G3 B3 D4 F4'), ch('C3 E3 G3 Bb3'), ch('C3 E3 G3 Bb3'),
    ch('G3 B3 D4 F4'), ch('E3 G3 B3 D4'), ch('A3 C4 E4 G4'), ch('D3 F#3 A3 C4'),
    ch('C3 E3 G3 B3'), ch('D3 F#3 A3 D4'), ch('B3 D4 F#4 A4'), ch('E3 G3 B3 D4'),
    ch('C3 E3 G3 B3'), ch('D3 F#3 A3 D4'), ch('A3 C4 E4 G4'), ch('D3 F#3 A3 C4'),
  ],
  melody: [
    'D5 - G5 - A5 B5 . G5',
    'F5 - D5 - . . . .',
    'E5 - G5 - Bb5 - A5 G5',
    'E5 - C5 - . . . .',
    'D5 - G5 - A5 B5 . D6',
    'B5 - A5 G5 E5 - G5 -',
    'A5 - C6 - B5 A5 G5 E5',
    'F#5 - - - A5 - D5 -',
    'E5 - - G5 - - C6 -',
    'B5 - A5 - F#5 - D5 -',
    'D5 - F#5 - B5 - A5 -',
    'G5 - - - E5 - D5 E5',
    'G5 - E5 G5 C6 - B5 C6',
    'D6 - - - A5 - F#5 A5',
    'C6 - B5 - A5 - G5 -',
    'F#5 - A5 - D6 - C6 -',
  ],
  bass: ['R - . R O . . R . S . R F . O .', 'R . R . O . R F . R . S O . F R', 'R - . R O . . R . S . R F . O .', 'R . R . O . R F . R . S O . F R', 'R - . R O . . R . S . R F . O .', 'R . R . O . R F . R . S O . F R', 'R - . R O . . R . S . R F . O .', 'R . R . O . R F . R . S O . F R',
    'R - . R O . . R . S . R F . O .', 'R . R . O . R F . R . S O . F R', 'R - . R O . . R . S . R F . O .', 'R . R . O . R F . R . S O . F R', 'R - . R O . . R . S . R F . O .', 'R . R . O . R F . R . S O . F R', 'R - . R O . . R . S . R F . O .', 'R . R . O . R . S . O . F . R .'],
  arp: ['. . . . . . . .', '. . . . . . . .', '. . . . . . . .', '. . . . . . . .',
    '. . . . . . . .', '. . . . . . . .', '. . . . . . . .', '. . . . . . . .',
    '0 1 2 3 2 1 2 3', '0 1 2 3 2 1 2 3', '0 1 2 3 2 1 2 3', '0 1 2 3 2 1 2 3',
    '0 1 2 3 2 1 2 3', '0 1 2 3 2 1 2 3', '0 1 2 3 2 1 2 3', '0 2 1 3 0 2 1 3'],
  drums: ['Kh . h . sh . h K . Kh h . sh . h g', 'Kh . h K sh . h . . Kh h K sh g o .', 'Kh . h . sh . h K . Kh h . sh . h g', 'Kh . h K sh . h . . Kh h K sh g o .', 'Kh . h . sh . h K . Kh h . sh . h g', 'Kh . h K sh . h . . Kh h K sh g o .', 'Kh . h . sh . h K . Kh h . sh . h g', 'Kh . h . sh . h K . Kh h . s g s s',
    'Kh . h . sh . h K . Kh h . sh . h g', 'Kh . h K sh . h . . Kh h K sh g o .', 'Kh . h . sh . h K . Kh h . sh . h g', 'Kh . h K sh . h . . Kh h K sh g o .', 'Kh . h . sh . h K . Kh h . sh . h g', 'Kh . h K sh . h . . Kh h K sh g o .', 'Kh . h . sh . h K . Kh h . sh . h g', 'Kh . h K sh . h . Kh . s . s s s s'],
  stabs: ['. . . . . . . . . . . . . . . .', '. . . . . . . . x . . x . . x .',
    '. . . . . . . . . . . . . . . .', '. . . . . . . . x . . x . x . .',
    '. . . . . . . . . . . . . . . .', '. . . . . . . . . . . . . . x .',
    '. . . . . . . . . . . . . . . .', 'x . . x . . x . . . . . . . . .',
    'x . . . . . . . . . . . . . . .', '. . . . . . . . . . . . . . . .',
    'x . . . . . . . . . . . . . . .', '. . . . . . . . . . . . x . x .',
    'x . . . . . . . . . . . . . . .', '. . . . . . . . . . . . . . . .',
    'x . . . . . . . . . . . . . . .', '. . . . . . . . x . . x . . . .'],
};

export const MENU_VARIANTS = { hype: HYPE, route: ROUTE, jam: JAM, fastbreak: FASTBREAK } as const;
export type MenuVariant = keyof typeof MENU_VARIANTS;

/**
 * The menu and franchise screens rotate through all four. `?menu=hype|route|jam|fastbreak` on the URL pins one
 * (handy for trying them on a phone).
 */
export function menuPlaylist(pin: string | null): Song[] {
  return pin && pin in MENU_VARIANTS ? [MENU_VARIANTS[pin as MenuVariant]] : Object.values(MENU_VARIANTS);
}
