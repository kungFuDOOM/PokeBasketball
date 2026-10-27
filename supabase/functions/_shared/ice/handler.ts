// pokejam-ice: short-lived TURN credentials (Cloudflare Realtime TURN) for one online match's direct link.
//
// The browser calls it with the player's own session (supabase.functions.invoke). It answers only a player in
// an active match (pokejam_ice_ok, as that player, which also rate-limits), and only from the game's own sites.
// The TURN key never leaves the server; the credentials it mints expire in an hour.

export interface IceConfig {
  turnKeyId: string;
  turnApiToken: string;
  /** Sites allowed to call (exact origins). Empty: any origin (auth and the rate limit still apply). */
  origins: string[];
}

export interface IceDeps {
  /** pokejam_ice_ok(p_match) as the caller (their JWT), or throws. */
  iceOk(jwt: string, matchId: string): Promise<boolean>;
  fetch: typeof fetch;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function iceConfig(get: (k: string) => string | undefined): IceConfig | null {
  const id = get('TURN_KEY_ID')?.trim();
  const token = get('TURN_KEY_API_TOKEN')?.trim();
  if (!id || !token) return null;
  return { turnKeyId: id, turnApiToken: token, origins: (get('ICE_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean) };
}

export async function iceHandler(req: Request, cfg: IceConfig | null, deps: IceDeps): Promise<Response> {
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
  // Not set up: the game just stays on Realtime.
  if (!cfg) return json({ iceServers: [] });
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!jwt) return json({ error: 'sign in first' }, 401);
  let match: unknown;
  try {
    match = ((await req.json()) as { match?: unknown } | null)?.match;
  } catch { /* handled below */ }
  if (typeof match !== 'string' || !UUID.test(match)) return json({ error: 'bad match' }, 400);
  let ok = false;
  try {
    ok = await deps.iceOk(jwt, match);
  } catch {
    return json({ error: 'not allowed' }, 403);
  }
  if (!ok) return json({ error: 'not allowed' }, 403);
  const r = await deps.fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cfg.turnKeyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.turnApiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: 3600 }),
  });
  if (!r.ok) return json({ iceServers: [] });
  const body = (await r.json()) as { iceServers?: unknown };
  const list = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
  // Browsers refuse port 53, so drop those URLs; keep only TURN (the link is relay-only).
  const servers = list.flatMap((s) => {
    const e = s as { urls?: string | string[]; username?: string; credential?: string };
    const urls = (Array.isArray(e.urls) ? e.urls : e.urls ? [e.urls] : []).filter((u) => /^turns?:/.test(u) && !/:53(\?|$)/.test(u));
    return urls.length && e.username && e.credential ? [{ urls, username: e.username, credential: e.credential }] : [];
  });
  return json({ iceServers: servers });
}
