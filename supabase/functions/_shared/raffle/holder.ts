// pokejam-raffle-holder: the signed-in player's holder entries, read from Solana on the server.
// The browser sends no balance and no RPC URL. The draw uses the same cap, one balance at a time.

export interface HolderUser { id: string; anonymous: boolean }

export interface HolderDeps {
  userOf(jwt: string): Promise<HolderUser | null>;
  /** Distinct wallet addresses for this account, linked first. */
  walletsOf(userId: string): Promise<string[]>;
  /** Whole tokens for each wallet, same order. */
  wholes(mint: string, wallets: string[]): Promise<bigint[]>;
  config(): Promise<{ pjamPerEntry: number; pjamCountedCap: number; pjamMint: string }>;
}

/** Holder entries: each balance is capped, then floor(counted / step), then the counts add. */
export function holderFromWholes(wholes: readonly bigint[], per: number, cap: number): number {
  if (!Number.isInteger(per) || per <= 0 || !Number.isInteger(cap) || cap <= 0) return 0;
  const step = BigInt(per);
  const limit = BigInt(cap);
  let n = 0;
  for (const w of wholes) {
    if (w <= 0n) continue;
    const counted = w > limit ? limit : w;
    const add = counted / step;
    n += add > 2_147_483_647n ? 2_147_483_647 : Number(add);
  }
  return n;
}

export async function holderHandler(req: Request, origins: string[], deps: HolderDeps): Promise<Response> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = origins.includes(origin);
  const cors: Record<string, string> = {
    'access-control-allow-origin': allowed ? origin : 'null',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!allowed) return json({ error: 'origin not allowed' }, 403);
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const user = jwt ? await deps.userOf(jwt).catch(() => null) : null;
  if (!user) return json({ error: 'Sign in to see holder entries' }, 401);
  if (user.anonymous) return json({ error: 'Sign in with Discord or Phantom first', code: 'guest' }, 403);
  let cfg: { pjamPerEntry: number; pjamCountedCap: number; pjamMint: string };
  try { cfg = await deps.config(); } catch {
    return json({ error: 'Could not read the raffle settings.' }, 502);
  }
  let wallets: string[];
  try { wallets = await deps.walletsOf(user.id); } catch {
    return json({ error: 'Could not read the linked wallet.' }, 502);
  }
  const clean = [...new Set(wallets.filter((w) => typeof w === 'string' && w.length > 0))];
  if (!clean.length) return json({ ok: true, wallet: null, holder: 0 });
  let wholes: bigint[];
  try { wholes = await deps.wholes(cfg.pjamMint, clean); } catch {
    return json({ error: 'Could not read the PJAM balance.' }, 502);
  }
  return json({ ok: true, wallet: clean[0], holder: holderFromWholes(wholes, cfg.pjamPerEntry, cfg.pjamCountedCap) });
}
