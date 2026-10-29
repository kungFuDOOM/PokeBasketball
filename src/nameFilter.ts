// Name filter for team names (and anything else a player types that other people read): slurs and vulgar words,
// including look-alike characters (sh1t, f@ck), spacing (f u c k) and repeats (fuuuck). Pure: no DOM, no network.
// The word lists are nameFilterData.json (obscenity, MIT, and cuss, MIT; see docs/third-party-wordlist.md), shared with the
// ranked username filter. "Severe" terms are blocked anywhere inside a name; "mild" terms only as a whole word, so common
// words that merely contain them (Classic, Assassins, Titans, Analysts) pass. A short allow list lets known innocent words
// that contain a severe term through (Scunthorpe, Shiitake, Dickens). Client-side only: the server is not the authority here.
import data from './multiplayer/ranked/nameFilterData.json';

/** Extra terms on top of the shared lists: compounds the lists miss (a mild term inside a longer word), and spellings. */
const EXTRA_SEVERE = ['asshole', 'arsehole', 'kissass', 'dumbass', 'jackass', 'smartass', 'fatass', 'asswipe', 'asslick', 'cocksuck', 'phuck', 'dumbfuck'];
const EXTRA_MILD = ['fck', 'fcuk', 'sht', 'shyt', 'biatch', 'dik'];
const EXTRA_ALLOW = ['therapist', 'grapist'];

/** Repeated letters collapsed: "fuuuck" -> "fuck". */
const collapse = (s: string) => s.replace(/(.)\1+/g, '$1');
const uniq = (xs: readonly string[], f: (s: string) => string = (s) => s) => [...new Set(xs.map(f))];
/** Longest first, so overlapping allowed words resolve the same way every time. */
const byLength = (xs: string[]) => [...xs].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));

const SEVERE = uniq([...data.severe, ...EXTRA_SEVERE], collapse);
const ALLOW = byLength(uniq([...data.allow, ...EXTRA_ALLOW], collapse));

/** A mild term as a regex: each run of a letter must be at least as long as in the term ("ass" -> ^a+s{2,}$). */
const mildRegex = (term: string) => new RegExp(`^${[...term.matchAll(/(.)\1*/g)].map((m) => `${m[1]}{${m[0].length},}`).join('')}$`);
const MILD = uniq([...data.mild, ...EXTRA_MILD]).map(mildRegex);

const LOOKALIKE: Record<string, string> = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i' };

/** Lowercase, look-alikes mapped (1 is i or l, v is v or u), everything that is not a letter dropped. */
function skeletons(text: string): string[] {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const one of ['i', 'l']) {
    const base = lower.replace(/[034578@$!1]/g, (c) => (c === '1' ? one : LOOKALIKE[c]));
    out.add(base.replace(/[^a-z]/g, ''));
    out.add(base.replace(/v/g, 'u').replace(/[^a-z]/g, ''));
  }
  return [...out];
}

const strip = (s: string, allow: string[]) => allow.reduce((acc, w) => acc.split(w).join(' '), s);
const mildHit = (k: string) => k !== '' && MILD.some((re) => re.test(k));

/** True when a name has a slur or vulgar word in it. Case, spacing, punctuation, look-alikes and repeats don't help. */
export function isNameBlocked(name: string): boolean {
  if (!name) return false;
  const sk = skeletons(name);
  for (const k of sk) {
    const s = strip(collapse(k), ALLOW);
    if (SEVERE.some((t) => s.includes(t)) || mildHit(k)) return true;
  }
  // Each word on its own, so "Ass Kickers" is caught although "asskickers" is not a mild term.
  for (const word of name.toLowerCase().split(/[^a-z0-9@$!*]+/)) if (word && skeletons(word).some(mildHit)) return true;
  return false;
}

/** What to tell a player whose team name was refused. */
export const NAME_BLOCKED_MESSAGE = "That team name isn't allowed. Please pick another.";

/** A name that is safe to show: itself, or `fallback` (the team's default name) if it is blocked. */
export const safeName = (name: string, fallback: string): string => (isNameBlocked(name) ? fallback : name);
