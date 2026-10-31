// Usernames: the rules, the filter and the error text. Pure (no DOM, no network). The server enforces the same rules in
// supabase/migrations/20261114_pokejam_profiles.sql (pokejam_name_check); the lists come from nameFilterData.json and a test
// keeps both sides in step. The client check is for fast feedback only, the server is the authority.
import { SIGNIN_GOOGLE } from '../../config/features';
import data from './nameFilterData.json';

export const NAME_MIN = 3;
export const NAME_MAX = 16;
/** What a player without a username is called on screens that name players. */
export const FALLBACK_NAME = 'Player';

export type NameError = 'length' | 'charset' | 'reserved' | 'impersonation' | 'profanity';
export type ServerNameError = NameError | 'taken' | 'cooldown' | 'signin' | 'required';

/** Repeated letters collapsed: "fuuuck" -> "fuck". */
export const collapse = (s: string) => s.replace(/(.)\1+/g, '$1');

const LOOKALIKE: Record<string, string> = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i' };

/**
 * Lowercase, look-alike characters mapped (0 o, 3 e, 4 a, 5 s, 7 t, 8 b, @ a, $ s, ! i; 1 is either i or l, hence a list),
 * everything that is not a letter dropped (underscores, other digits). Repeats are collapsed by `normalizeName`, not here.
 */
export function skeletons(name: string): string[] {
  const lower = name.toLowerCase();
  const out = new Set<string>();
  for (const one of ['i', 'l']) {
    out.add(lower.replace(/[034578@$!1]/g, (c) => (c === '1' ? one : LOOKALIKE[c])).replace(/[^a-z]/g, ''));
  }
  return [...out];
}

/** Every normalised form of a name (lowercase, look-alikes, separators stripped, repeats collapsed). */
export const normalizeName = (name: string): string[] => [...new Set(skeletons(name).map(collapse))];

const uniq = (xs: readonly string[], f: (s: string) => string = (s) => s) => [...new Set(xs.map(f))].sort();
export const FILTER = {
  severe: uniq(data.severe, collapse),
  /** Stored as written: matched with `mildRegex`. */
  mild: uniq(data.mild),
  allow: uniq(data.allow, collapse),
  reserved: uniq(data.reserved, collapse),
  impersonation: uniq(data.impersonation, collapse),
  impersonationAllow: uniq(data.impersonationAllow, collapse),
};

/** A mild term as a regex: each run of a letter must be at least as long as in the term ("ass" -> ^a+s{2,}$). */
export const mildRegex = (term: string) => new RegExp(`^${[...term.matchAll(/(.)\1*/g)].map((m) => `${m[1]}{${m[0].length},}`).join('')}$`);
const MILD = FILTER.mild.map(mildRegex);
const RESERVED = new Set(FILTER.reserved);

/** Longest first, like the server, so overlapping allowed words resolve the same way. */
const byLength = (xs: string[]) => [...xs].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
const ALLOW = byLength(FILTER.allow);
const IMPERSONATION_ALLOW = byLength(FILTER.impersonationAllow);
const strip = (s: string, allow: string[]) => allow.reduce((acc, w) => acc.split(w).join(' '), s);
const mildHit = (k: string) => k !== '' && MILD.some((re) => re.test(k));

/** Why a name can't be used, or null if the rules allow it. Order: length, charset, reserved, impersonation, profanity. */
export function checkUsername(name: string): NameError | null {
  if (name.length < NAME_MIN || name.length > NAME_MAX) return 'length';
  if (!/^[A-Za-z0-9_]+$/.test(name) || !/[A-Za-z]/.test(name)) return 'charset';
  const sk = skeletons(name);
  if (sk.some((k) => RESERVED.has(collapse(k)))) return 'reserved';
  if (sk.some((k) => { const s = strip(collapse(k), IMPERSONATION_ALLOW); return FILTER.impersonation.some((t) => s.includes(t)); })) return 'impersonation';
  for (const k of sk) {
    const s = strip(collapse(k), ALLOW);
    if (FILTER.severe.some((t) => s.includes(t)) || mildHit(k)) return 'profanity';
  }
  for (const seg of name.toLowerCase().split('_')) if (skeletons(seg).some(mildHit)) return 'profanity';
  return null;
}

const MESSAGES: Record<ServerNameError, string> = {
  length: `Usernames are ${NAME_MIN} to ${NAME_MAX} characters.`,
  charset: 'Use letters, numbers and underscores only, with at least one letter.',
  reserved: 'That name is reserved. Pick another.',
  impersonation: 'That name looks like it belongs to staff. Pick another.',
  profanity: 'That name is not allowed. Pick another.',
  taken: 'That name is taken. Pick another.',
  cooldown: 'You changed your name recently. Try again later.',
  signin: `Sign in with ${SIGNIN_GOOGLE ? 'Google or Phantom' : 'Phantom'} to pick a username.`,
  required: 'Pick a username before joining Ranked.',
};

/** Player-facing text for an error code. */
export const nameErrorText = (e: ServerNameError) => MESSAGES[e];

/** Reads a server error ('username:taken', 'username:cooldown:12') into text; null if it isn't a username error. */
export function serverNameError(message: string): string | null {
  const m = /username:(length|charset|reserved|impersonation|profanity|taken|cooldown|signin|required)(?::(\d+))?/.exec(message);
  if (!m) return null;
  const code = m[1] as ServerNameError;
  if (code === 'cooldown' && m[2]) {
    const d = Number(m[2]);
    return `You can change your name again in ${d} ${d === 1 ? 'day' : 'days'}.`;
  }
  return MESSAGES[code];
}

/** The name to show for a player: their username, or "Player". */
export const displayName = (name: string | null | undefined): string => (name && name.trim() !== '' ? name : FALLBACK_NAME);
