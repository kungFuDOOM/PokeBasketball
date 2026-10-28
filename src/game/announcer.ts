import type { GameEvent } from './types';

/**
 * The arena announcer: recorded lines (public/announcer/*.mp3, ElevenLabs v4, "David - Sports Arena Announcer"; voiced for PokéJam by thepaypay420)
 * called on the same moments as the HUD's popups. Display only: the announcer never touches the sim, so a
 * seeded replay is unchanged, and variants are picked with Math.random.
 */
export const CALLS = {
  tipoff: ['tipoff'],
  heating: ['heating_1', 'heating_2'],
  fire: ['fire_1', 'fire_2'],
  cooled: ['cooled'],
  dunk: ['dunk_1', 'dunk_2', 'dunk_3', 'dunk_4', 'dunk_5'],
  three: ['three_1', 'three_2', 'three_3'],
  block: ['block_1', 'block_2', 'block_3'],
  steal: ['steal_1', 'steal_2'],
  oop: ['oop'],
  airball: ['airball'],
  super: ['super'],
  buzzer: ['buzzer'],
  shotclock: ['shotclock'],
  q1: ['q1'],
  half: ['half'],
  q3: ['q3'],
  ot: ['ot'],
  final: ['final'],
  /** The Play of the Game title card (not an event: src/screens/potg.ts says it). potg_3 is "Let's see that one again". */
  potg: ['potg_1', 'potg_2', 'potg_3'],
} as const;

export type Call = keyof typeof CALLS;
export const CLIPS: string[] = [...new Set(Object.values(CALLS).flat())];

/** How much each call matters: a bigger moment cuts off a smaller one, and goes first when several are waiting. */
const PRIORITY: Record<Call, number> = {
  final: 10, potg: 10, buzzer: 9, tipoff: 8, q1: 8, half: 8, q3: 8, ot: 8, fire: 7, heating: 6, oop: 5,
  dunk: 4, three: 4, block: 4, super: 3, steal: 3, shotclock: 3, airball: 2, cooled: 1,
};

/** A call that lands while he's mid-line waits up to this long (seconds) for him to finish; after that it's old news. */
const FRESH = 1.2;
/** Breath between two lines. */
const GAP = 0.06;

/** Which call, if any, an event deserves. */
export function callFor(e: GameEvent): Call | null {
  switch (e.kind) {
    case 'score': return e.how === 'dunk' ? 'dunk' : e.points === 3 ? 'three' : null;
    case 'miss': return e.airball ? 'airball' : null;
    case 'block': return 'block';
    case 'steal': return 'steal';
    case 'oop': return 'oop';
    case 'heating': return 'heating';
    case 'fire': return e.on ? 'fire' : 'cooled';
    case 'special': return e.hits.some((h) => h.mult >= 2) ? 'super' : null;
    case 'buzzerbeater': return 'buzzer';
    case 'shotclock': return 'shotclock';
    case 'final': return 'final';
    case 'quarter':
      if (e.label === '1ST QUARTER') return 'tipoff';
      if (e.label === 'END OF Q1') return 'q1';
      if (e.label === 'HALFTIME') return 'half';
      if (e.label === 'END OF Q3') return 'q3';
      if (e.label === 'END OF REGULATION') return 'ot'; // tied after the 4th, or after an overtime
      return null;
    default: return null;
  }
}

/** Decides what the announcer says and when; playback is the caller's (Voice in voice.ts). */
export class Announcer {
  private busyUntil = -Infinity;
  private speaking: Call | null = null;
  /** Calls waiting for him to finish the current line, with when each moment happened. */
  private waiting = new Map<Call, number>();
  private lastClip = new Map<Call, string>();

  constructor(private rand: () => number = Math.random) {}

  /**
   * The clip to play now, or null. Call it every frame with that frame's events (an empty list too, so a call
   * that's waiting gets said as soon as he's free). `now` is in seconds of game time, so a paused game holds the
   * announcer too; `clipLength` gives a clip's duration so he never talks over himself.
   */
  next(events: GameEvent[], now: number, clipLength: (clip: string) => number): { call: Call; clip: string } | null {
    for (const e of events) {
      const c = callFor(e);
      if (c) this.waiting.set(c, now);
    }
    for (const [c, at] of this.waiting) if (now - at > FRESH) this.waiting.delete(c);
    let best: Call | null = null;
    for (const [c, at] of this.waiting) {
      if (!best || PRIORITY[c] > PRIORITY[best] || (PRIORITY[c] === PRIORITY[best] && at < this.waiting.get(best)!)) best = c;
    }
    if (!best) return null;
    // Mid-line, only a much bigger moment cuts in (on fire over a steal, the final horn over anything);
    // anything else waits its turn.
    if (now < this.busyUntil && this.speaking && PRIORITY[best] < PRIORITY[this.speaking] + 3) return null;
    this.waiting.delete(best);
    const options = CALLS[best].filter((v) => CALLS[best!].length === 1 || v !== this.lastClip.get(best!));
    const clip = options[Math.floor(this.rand() * options.length) % options.length];
    this.lastClip.set(best, clip);
    this.speaking = best;
    this.busyUntil = now + clipLength(clip) + GAP;
    return { call: best, clip };
  }
}
