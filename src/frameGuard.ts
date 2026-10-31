// Pure decision logic for the frame/hostname guard. No DOM access here, so it can be unit-tested directly;
// src/framed.ts gathers the inputs from the browser and acts on the verdict.

/** Hostnames the game may boot on. pokejam-test.vercel.app is deliberately absent (separate repo and build). */
export const ALLOWED_HOSTS: readonly string[] = [
  'pokejam.xyz',
  'www.pokejam.xyz',
  'kungfudoom.github.io',
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
];

/** Parent origins that may frame the game (besides the page's own origin). */
export const ALLOWED_PARENT_ORIGINS: readonly string[] = ['https://pokejam.xyz', 'https://www.pokejam.xyz'];

export interface FrameGuardInput {
  hostname: string;
  /** window.top === window.self */
  isTop: boolean;
  /** location.ancestorOrigins as an array, or undefined/null where the browser lacks it. */
  ancestorOrigins?: readonly string[] | null;
  /** document.referrer */
  referrer?: string | null;
  /** window.top.location.origin when readable (same-origin top), else undefined/null. */
  sameOriginTopOrigin?: string | null;
}

export type FrameGuardVerdict = { ok: true } | { ok: false; reason: string };

function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, '');
}

function usableOrigin(o: string | null | undefined): string | null {
  if (typeof o !== 'string') return null;
  const t = o.trim();
  return t && t !== 'null' ? t : null;
}

function originOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    return usableOrigin(new URL(url).origin);
  } catch {
    return null;
  }
}

export function frameGuardVerdict(input: FrameGuardInput): FrameGuardVerdict {
  const host = normalizeHost(String(input.hostname ?? ''));
  if (!ALLOWED_HOSTS.includes(host)) return { ok: false, reason: `hostname not allowed: ${host || '(empty)'}` };
  if (input.isTop) return { ok: true };

  const own = usableOrigin(input.sameOriginTopOrigin);
  const allowedParent = (o: string | null): boolean =>
    o !== null && (ALLOWED_PARENT_ORIGINS.includes(o) || (own !== null && o === own));

  const ancestors = input.ancestorOrigins;
  if (ancestors && ancestors.length > 0) {
    for (const a of ancestors) {
      const o = usableOrigin(a);
      if (!allowedParent(o)) return { ok: false, reason: `framed by foreign ancestor: ${a}` };
    }
    return { ok: true };
  }

  const ref = originOf(input.referrer);
  if (ref === null) return { ok: false, reason: 'framed by unknown parent (no usable referrer)' };
  if (!allowedParent(ref)) return { ok: false, reason: `framed by foreign parent: ${ref}` };
  return { ok: true };
}
