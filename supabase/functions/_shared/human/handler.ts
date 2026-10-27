// pokejam-human: checks a Cloudflare Turnstile token before online play, and gives the player a short pass.
//
// The browser calls it with the player's own session (supabase.functions.invoke) and a Turnstile token. The token
// is verified with Cloudflare's Siteverify using TURNSTILE_SECRET_KEY (a function secret, never in the repo or the
// client). On success the player gets a pass (pokejam_grant_human) that quick match, making a room and joining one
// check while `require_human` is on. Without the secret it answers "skipped", so local and preview builds work.

export interface HumanConfig {
  secret: string;
  /** Minutes a pass lasts. */
  passMinutes: number;
  /** Sites allowed to call (exact origins). Empty: any origin (the session and Cloudflare's check still apply). */
  origins: string[];
}

export interface HumanDeps {
  /** The signed-in player behind a session token, or null (checked with Supabase Auth). */
  userOf(jwt: string): Promise<string | null>;
  /** Give that player a pass; returns when it runs out (ISO). */
  grant(userId: string, minutes: number): Promise<string>;
  fetch: typeof fetch;
}

export const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function humanConfig(get: (k: string) => string | undefined): HumanConfig | null {
  const secret = get('TURNSTILE_SECRET_KEY')?.trim();
  if (!secret) return null;
  const minutes = Number(get('HUMAN_PASS_MINUTES') ?? 20);
  return {
    secret,
    passMinutes: Number.isFinite(minutes) ? Math.max(1, Math.min(60, Math.round(minutes))) : 20,
    origins: (get('HUMAN_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

export async function humanHandler(req: Request, cfg: HumanConfig | null, deps: HumanDeps): Promise<Response> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = !cfg?.origins.length || cfg.origins.includes(origin);
  const cors: Record<string, string> = {
    'access-control-allow-origin': allowed ? (origin || '*') : 'null',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!allowed) return json({ error: 'origin not allowed' }, 403);
  // Not set up: nothing to check (and `require_human` should be off).
  if (!cfg) return json({ ok: true, skipped: true });
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const user = jwt ? await deps.userOf(jwt).catch(() => null) : null;
  if (!user) return json({ error: 'sign in first' }, 401);
  let token: unknown;
  try {
    token = ((await req.json()) as { token?: unknown } | null)?.token;
  } catch { /* handled below */ }
  if (typeof token !== 'string' || !token || token.length > 2048) return json({ error: 'missing check' }, 400);
  const form = new FormData();
  form.append('secret', cfg.secret);
  form.append('response', token);
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (ip) form.append('remoteip', ip);
  let ok = false;
  try {
    const r = await deps.fetch(SITEVERIFY, { method: 'POST', body: form });
    ok = r.ok && ((await r.json()) as { success?: unknown }).success === true;
  } catch {
    return json({ error: 'could not reach the check' }, 502);
  }
  if (!ok) return json({ error: 'check failed' }, 403);
  const until = await deps.grant(user, cfg.passMinutes);
  return json({ ok: true, until });
}
