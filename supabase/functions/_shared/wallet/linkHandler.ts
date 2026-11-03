// pokejam-link-wallet: a signed-in player proves a Phantom wallet is theirs, and it is stored on that same user id.
// The browser sends the message and the signature. This function checks the message, checks the signature, then
// asks the database to store the address. Nothing here creates a session or a second account.
import { base58Decode } from '../pack/bytes.ts';
import { checkLinkMessage, linkFields, USER_ID_RE } from './link.ts';

export interface LinkUser { id: string; anonymous: boolean }

export interface LinkResult { ok: boolean; code?: string; wallet?: string }

export interface LinkDeps {
  userOf(jwt: string): Promise<LinkUser | null>;
  verify(address: string, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
  link(userId: string, wallet: string, nonce: string): Promise<LinkResult>;
  now?: () => number;
}

const SIG_BYTES = 64;

function isSignature(s: string): boolean {
  try { return base58Decode(s).length === SIG_BYTES; } catch { return false; }
}

/** CORS, a real session, a well-formed link message, a real signature, then the database. */
export async function linkWalletHandler(req: Request, origins: string[], deps: LinkDeps): Promise<Response> {
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
  if (!user || !USER_ID_RE.test(user.id)) return json({ error: 'Sign in to link a wallet' }, 401);
  if (user.anonymous) return json({ error: 'Sign in with Discord or Phantom first', code: 'guest' }, 403);
  let body: { message?: unknown; signature?: unknown } | null = null;
  try { body = (await req.json()) as { message?: unknown; signature?: unknown }; } catch { /* handled below */ }
  const message = body?.message;
  const signature = body?.signature;
  if (typeof message !== 'string' || typeof signature !== 'string' || !isSignature(signature)) return json({ error: 'That link request was not valid', code: 'bad_message' }, 400);
  const fields = linkFields(message);
  if (!fields) return json({ error: 'That link request was not valid', code: 'bad_message' }, 400);
  const now = deps.now?.() ?? Date.now();
  const check = checkLinkMessage(message, { address: fields.address, userId: user.id, nonce: fields.nonce, now });
  if (check === 'expired') return json({ error: 'That link request expired. Try again.', code: 'expired' }, 400);
  if (check !== 'ok') return json({ error: 'That link request does not match this account.', code: 'bad_message' }, 400);
  let sig: Uint8Array;
  try { sig = base58Decode(signature); } catch { return json({ error: 'That link request was not valid', code: 'bad_message' }, 400); }
  const ok = await deps.verify(fields.address, new TextEncoder().encode(message), sig).catch(() => false);
  if (!ok) return json({ error: 'The wallet signature did not match.', code: 'bad_signature' }, 400);
  let stored: LinkResult;
  try { stored = await deps.link(user.id, fields.address, fields.nonce); } catch {
    return json({ error: 'Could not link the wallet. Try again in a moment.' }, 502);
  }
  if (!stored.ok) {
    const text = stored.code === 'taken' ? 'That wallet is already linked to another account.'
      : stored.code === 'already' ? 'This account already has a different wallet.'
      : stored.code === 'replay' ? 'That link request was already used. Try again.'
      : stored.code === 'rate' ? 'Too many link attempts. Try again in a while.'
      : 'Could not link the wallet.';
    const status = stored.code === 'rate' ? 429 : stored.code === 'taken' || stored.code === 'already' ? 409 : 400;
    return json({ error: text, code: stored.code }, status);
  }
  return json({ ok: true, wallet: stored.wallet ?? fields.address });
}
