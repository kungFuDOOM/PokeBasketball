// pokejam-raffle-draw: a moderator draws one closed week. This function reads PJAM balances. The database
// generates the seed and picks the winner, so this function cannot choose who wins.

export interface Qualifier { user_id: string; wallet: string | null; wallets?: string[] }

export interface Prep {
  ok: boolean;
  code?: string;
  already?: boolean;
  week_start?: string;
  mint?: string;
  qualifiers?: Qualifier[];
  draw?: unknown;
}

export interface RaffleDrawDeps {
  isAdmin(jwt: string): Promise<boolean>;
  adminId(jwt: string): Promise<string | null>;
  prep(week: string): Promise<Prep>;
  balances(mint: string, rows: Qualifier[]): Promise<Record<string, string>>;
  commit(week: string, balances: Record<string, string>, adminId: string | null): Promise<{ ok: boolean; code?: string; draw?: unknown }>;
}

export interface RaffleDrawConfig { origins: string[] }

const WEEK = /^\d{4}-\d{2}-\d{2}$/;

export function raffleDrawConfig(get: (k: string) => string | undefined): RaffleDrawConfig {
  return { origins: (get('RAFFLE_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean) };
}

export async function raffleDrawHandler(req: Request, cfg: RaffleDrawConfig, deps: RaffleDrawDeps): Promise<Response> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = !cfg.origins.length || cfg.origins.includes(origin);
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
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!jwt) return json({ error: 'sign in first' }, 401);
  if (!(await deps.isAdmin(jwt).catch(() => false))) return json({ error: 'moderators only' }, 403);
  let week: unknown;
  try { week = ((await req.json()) as { week?: unknown } | null)?.week; } catch { week = null; }
  if (typeof week !== 'string' || !WEEK.test(week)) return json({ error: 'week must be YYYY-MM-DD' }, 400);
  const prep = await deps.prep(week);
  if (!prep.ok && prep.code === 'open') return json({ error: 'That week is still open.', code: 'open' }, 409);
  if (!prep.ok) return json({ error: 'That week is not a Monday.', code: prep.code ?? 'bad_week' }, 400);
  if (prep.already) return json({ ok: true, already: true, draw: prep.draw });
  let balances: Record<string, string>;
  try {
    balances = await deps.balances(prep.mint ?? '', prep.qualifiers ?? []);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Could not read PJAM balances.' }, 502);
  }
  const drawn = await deps.commit(week, balances, await deps.adminId(jwt));
  if (!drawn.ok) return json({ error: 'The draw was not recorded.', code: drawn.code }, drawn.code === 'open' ? 409 : 400);
  return json({ ok: true, already: false, draw: drawn.draw });
}
