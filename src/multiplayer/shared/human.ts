// The human check before online matchmaking (issue #20). When the server requires it (`require_human`), quick match,
// making a room and joining one need a fresh pass: the player solves a Cloudflare Turnstile check, the
// pokejam-human Edge Function verifies the token with Cloudflare and grants the pass. Off (no site key, or the
// server doesn't require it): nothing is shown.
import type { SupabaseClient } from '@supabase/supabase-js';
import { BotCheckError } from './capacity';
import { CAPTCHA_ON, captchaToken } from './captcha';
import { sleep } from './throttle';

/** A pass is used until this close to running out, then renewed. */
const MARGIN_MS = 60_000;

/** The server refused for lack of a pass. */
export const needsHuman = (e: unknown) => /human check needed/i.test((e as Error)?.message ?? '');

export interface HumanDeps {
  rpc(fn: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  /** The server's verdict; `reason` says why when it refused (or couldn't be reached). */
  invoke(token: string): Promise<{ ok?: boolean; skipped?: boolean; reason?: string } | null>;
  token(): Promise<string>;
  /** True when this build can show the check at all (a site key is set). */
  enabled: boolean;
  now(): number;
  gate?: HumanGate;
  /** Waits (tests swap this out). */
  pause?(ms: number): Promise<void>;
}

/** After a failed check, the next one waits this long, so a retry button can't hammer Turnstile and pokejam-human. */
const RETRY_GAP_MS = 3000;

/** Shared across calls so concurrent checks become one and a failure slows the next try. */
export interface HumanGate {
  failedAt: number;
  flights: Map<boolean, Promise<void>>;
}

/**
 * Make sure the player has a pass if the server wants one: `force` after the server said "human check needed".
 * With a `gate` (the real deps have one): calls at the same time share one check, and a retry soon after a failure waits.
 */
export function ensureHuman(d: HumanDeps, force = false): Promise<void> {
  const g = d.gate;
  if (!g) return check(d, force);
  let p = g.flights.get(force);
  if (!p) {
    p = (async () => {
      const wait = g.failedAt + RETRY_GAP_MS - d.now();
      if (wait > 0) await (d.pause ?? sleep)(wait);
      try {
        await check(d, force);
      } catch (e) {
        g.failedAt = d.now();
        throw e;
      }
    })().finally(() => g.flights.delete(force));
    g.flights.set(force, p);
  }
  return p;
}

async function check(d: HumanDeps, force: boolean): Promise<void> {
  if (!d.enabled) return;
  if (!force) {
    const { data } = await d.rpc('pokejam_human_status');
    const s = data as { required?: boolean; until?: string | null } | null;
    if (!s?.required) return;
    if (s.until && Date.parse(s.until) - d.now() > MARGIN_MS) return;
  }
  const r = await d.invoke(await d.token());
  if (!r?.ok) throw new BotCheckError(`The server refused the bot check (${r?.reason ?? 'no answer'}). Try again.`);
}

/** Why the pokejam-human call failed, short enough to read off a phone screenshot. */
export async function serverReason(error: unknown): Promise<string> {
  const e = error as { name?: string; message?: string; context?: unknown };
  // The browser couldn't get an answer at all: usually the function isn't deployed (no CORS headers on the 404), or
  // this site isn't in HUMAN_ALLOWED_ORIGINS.
  if (e?.name === 'FunctionsFetchError') return 'pokejam-human unreachable: not deployed, or this site not in HUMAN_ALLOWED_ORIGINS';
  if (e?.name === 'FunctionsRelayError') return 'pokejam-human relay error';
  const res = e?.context;
  if (res instanceof Response) {
    const body = (await res.clone().json().catch(() => null)) as { error?: string; message?: string } | null;
    const why = body?.error ?? body?.message;
    return `${res.status}${why ? ` ${why}` : ''}`;
  }
  return e?.message || 'no answer';
}

/** The real thing: Turnstile in the page, the pokejam-human function on the server. */
const real = new WeakMap<SupabaseClient, HumanDeps>();
export function humanDeps(sb: SupabaseClient): HumanDeps {
  let d = real.get(sb);
  if (!d) real.set(sb, d = realDeps(sb));
  return d;
}

function realDeps(sb: SupabaseClient): HumanDeps {
  return {
    enabled: CAPTCHA_ON,
    gate: { failedAt: -Infinity, flights: new Map() },
    now: () => Date.now(),
    rpc: (fn) => sb.rpc(fn),
    token: () => captchaToken('Quick check before you play online.'),
    invoke: async (token) => {
      const { data, error } = await sb.functions.invoke('pokejam-human', { body: { token } });
      return error ? { ok: false, reason: await serverReason(error) } : (data as { ok?: boolean; skipped?: boolean });
    },
  };
}
