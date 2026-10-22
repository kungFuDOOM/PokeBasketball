// Share links: a drafted team (and its season, when one was played), packed into the URL hash (#s=<base64url>). No backend.
// Everything decoded from a link is untrusted: it is validated and clamped before use.
import { POKEMON } from '../data/pokemon';
import type { Playoff } from './sim';

export interface SharedTeam {
  name: string;
  color: string;
  color2: string;
  /** Five to ten dex numbers (ten from a Season or Franchise draft, five from Quick Play). */
  dex: number[];
  /** A team shared straight from a draft-complete screen: no season played, so no record (w, l, rank, teams, seed are 0). */
  noRecord?: boolean;
  w: number;
  l: number;
  rank: number;
  teams: number;
  /** Playoff seed 1-4, or 0. */
  seed: number;
  /** How many of this team's players made the season's All-Star five (0-5). */
  allStars?: number;
  playoff: Playoff;
}

const VERSION = 1;
const PLAYOFFS: Playoff[] = ['missed', 'semis', 'final', 'champion'];
const HEAD = 33;
const MAX_LINK = 160;
let known: Set<number> | null = null;

/** Control characters out, whitespace collapsed, at most 20 characters. */
export function cleanName(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

const hexBytes = (c: string): number[] => {
  const h = /^#[0-9a-f]{6}$/i.test(c) ? c : '#3b6fd8';
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const toHex = (b: number[]) => `#${b.map((x) => x.toString(16).padStart(2, '0')).join('')}`;

export function encodeShare(t: SharedTeam): string {
  const name = new TextEncoder().encode(cleanName(t.name)).slice(0, 60);
  const bytes = new Uint8Array(HEAD + name.length);
  bytes[0] = VERSION;
  // Unused dex slots stay 0 (a five-man Quick Play team).
  t.dex.slice(0, 10).forEach((d, i) => {
    bytes[1 + i * 2] = (d >> 8) & 255;
    bytes[2 + i * 2] = d & 255;
  });
  bytes.set(hexBytes(t.color), 21);
  bytes.set(hexBytes(t.color2), 24);
  // A draft with no season yet is all zeros here.
  if (!t.noRecord) {
    bytes[27] = t.w; bytes[28] = t.l; bytes[29] = t.rank; bytes[30] = t.teams;
    bytes[31] = Math.max(0, PLAYOFFS.indexOf(t.playoff));
    // Seed in the low four bits, the All-Star count in the high four (older links read as 0 All-Stars).
    bytes[32] = (t.seed & 15) | (Math.min(5, Math.max(0, t.allStars ?? 0)) << 4);
  }
  // Name length goes after the fixed header, so the header size stays fixed.
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes.slice(0, HEAD));
  out[HEAD] = name.length;
  out.set(name, HEAD + 1);
  let bin = '';
  out.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns null for anything that is not a well-formed link made by `encodeShare`. */
export function decodeShare(code: string): SharedTeam | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(code) || code.length > MAX_LINK) return null;
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const b = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    if (b.length < HEAD + 1 || b[0] !== VERSION) return null;
    const nameLen = b[HEAD];
    if (b.length !== HEAD + 1 + nameLen) return null;
    known ??= new Set(POKEMON.map((m) => m.dex));
    const dex: number[] = [];
    let ended = false;
    for (let i = 0; i < 10; i++) {
      const d = (b[1 + i * 2] << 8) | b[2 + i * 2];
      // Five to ten Pokémon, then only empty (0) slots.
      if (d === 0 && i >= 5) { ended = true; continue; }
      if (ended || !known.has(d)) return null;
      dex.push(d);
    }
    if (new Set(dex).size !== dex.length) return null;
    const [w, l, rank, teams, po] = [b[27], b[28], b[29], b[30], b[31]];
    const seed = b[32] & 15;
    const allStars = b[32] >> 4;
    if (allStars > 5) return null;
    const noRecord = w === 0 && l === 0 && rank === 0 && teams === 0 && po === 0 && seed === 0;
    if (!noRecord && (dex.length !== 10 || teams < 2 || teams > 32 || rank < 1 || rank > teams || w + l < 1 || w + l > 99 || po >= PLAYOFFS.length || seed > Math.min(4, teams))) return null;
    const name = cleanName(new TextDecoder('utf-8', { fatal: true }).decode(b.slice(HEAD + 1)));
    if (!name) return null;
    return { name, color: toHex([...b.slice(21, 24)]), color2: toHex([...b.slice(24, 27)]), dex, w, l, rank, teams, seed, playoff: PLAYOFFS[po], ...(noRecord ? { noRecord: true } : {}), ...(allStars ? { allStars } : {}) };
  } catch {
    return null;
  }
}

/** The share code in a URL hash, or null. */
export function shareFromHash(hash: string): SharedTeam | null {
  const m = /^#s=([^&]*)$/.exec(hash);
  return m ? decodeShare(m[1]) : null;
}

export function shareUrl(t: SharedTeam, loc: Pick<Location, 'origin' | 'pathname'> = location): string {
  return `${loc.origin}${loc.pathname}#s=${encodeShare(t)}`;
}
