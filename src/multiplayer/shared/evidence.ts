// Signed evidence for the winner check (winnerCheck.ts, docs/multiplayer.md "Pack Battles winner check").
//
// Every online match: each player makes a fresh Ed25519 key (matchKey) and registers its public half on the match
// row before tip-off. Every lockstep 'in' batch a player sends is signed (signTicks) and carries the signature
// (`g`), so the other player holds proof of exactly what was sent. After the game each player uploads everything
// signed they hold, and judge() can replay the match from it: nobody can invent the other player's moves (no key),
// and nobody can rewrite their own afterwards (the other player holds the originals; two versions is a forfeit).
import type { WireInput } from '../../game/sync';
import { MIN_DELAY, type InputRun, type NetMsg } from './lockstep';
import { signTicks, type Evidence, type MatchKeys, type MatchSetup, type SignedInputs } from './winnerCheck';

const SIG = /^[0-9a-f]{128}$/;
/** Most signed batches kept per side (a long game sends about 10,000). */
const MAX_BATCHES = 40_000;
/** Most ticks one batch may cover (lockstep's HISTORY). */
const MAX_RUN = 900;

type InMsg = Extract<NetMsg, { k: 'in' }>;

/** An 'in' message's runs, one input per tick. */
export const expandRuns = (r: InputRun[]): WireInput[] => r.flatMap(([n, mx, my, b]) => Array.from({ length: n }, () => ({ mx, my, b })));

export class EvidenceLog {
  readonly mine: SignedInputs[] = [];
  readonly theirs: SignedInputs[] = [];

  constructor(private key: CryptoKey, private matchId: string, readonly side: 0 | 1) {}

  /** Sign an outgoing input batch: the same message, plus its signature (`g`). Our copy is kept. */
  async sign(m: InMsg): Promise<InMsg> {
    if (!m.r.length) return m;
    const signed = await signTicks(this.key, this.matchId, this.side, m.s, expandRuns(m.r));
    if (this.mine.length < MAX_BATCHES) this.mine.push(signed);
    return { ...m, g: signed.sig };
  }

  /** Keep the other player's signed batch from an incoming message. Its signature is checked by the judge. */
  received(raw: unknown) {
    const m = raw as Partial<InMsg> | null;
    if (!m || m.k !== 'in' || typeof m.g !== 'string' || !SIG.test(m.g) || !Number.isInteger(m.s) || (m.s as number) < 0) return;
    if (!Array.isArray(m.r) || !m.r.length || this.theirs.length >= MAX_BATCHES) return;
    let total = 0;
    for (const run of m.r) {
      if (!Array.isArray(run) || run.length !== 4 || !Number.isInteger(run[0]) || run[0] < 1 || !run.slice(1).every(Number.isFinite)) return;
      total += run[0];
    }
    if (total > MAX_RUN) return;
    const frames = expandRuns(m.r as InputRun[]).map((w): [number, number, number] => [w.mx, w.my, w.b | 0]);
    this.theirs.push({ side: (1 - this.side) as 0 | 1, from: (m.s as number) + 1, frames, sig: m.g });
  }

  /** Everything to upload: both sides' signed inputs, trimmed to what the judge needs. */
  evidence(setup: MatchSetup, keys: MatchKeys): Evidence {
    return { setup, keys, inputs: [...cover(this.mine), ...cover(this.theirs)], applied: [], lockstep: { emptyTicks: MIN_DELAY } };
  }
}

/**
 * The fewest batches that still cover every frame any batch covers (lockstep resends overlap heavily), plus every
 * batch that disagrees with them about some frame: two signed versions of one frame is the proof of cheating the
 * judge looks for, so those are never trimmed.
 */
export function cover(batches: SignedInputs[]): SignedInputs[] {
  const sorted = [...batches].sort((a, b) => a.from - b.from || b.frames.length - a.frames.length);
  const end = (b: SignedInputs) => b.from + b.frames.length - 1;
  const kept: SignedInputs[] = [];
  let i = 0;
  let need = sorted.length ? sorted[0].from : 0;
  while (i < sorted.length) {
    if (sorted[i].from > need) need = sorted[i].from; // a gap nobody covered
    let best: SignedInputs | null = null;
    while (i < sorted.length && sorted[i].from <= need) {
      if (!best || end(sorted[i]) > end(best)) best = sorted[i];
      i++;
    }
    if (best && end(best) >= need) {
      kept.push(best);
      need = end(best) + 1;
    }
  }
  // Anything that contradicts what's kept stays too.
  const slot = new Map<number, string>();
  for (const b of kept) b.frames.forEach((f, k) => slot.set(b.from + k, f.join()));
  const keptSet = new Set(kept);
  for (const b of batches) {
    if (keptSet.has(b)) continue;
    if (b.frames.some((f, k) => { const s = slot.get(b.from + k); return s !== undefined && s !== f.join(); })) { kept.push(b); keptSet.add(b); }
  }
  return kept;
}

/** Evidence as a compact string for upload: gzip, then base64. */
export async function pack(e: Evidence): Promise<string> {
  const gz = await new Response(new Blob([JSON.stringify(e)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const bytes = new Uint8Array(gz);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `gz1:${btoa(bin)}`;
}

/** The judge's side of pack(). */
export async function unpack(s: string): Promise<Evidence> {
  if (!s.startsWith('gz1:')) throw new Error('unknown evidence format');
  const bytes = Uint8Array.from(atob(s.slice(4)), (c) => c.charCodeAt(0));
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text) as Evidence;
}
