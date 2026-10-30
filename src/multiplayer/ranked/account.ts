// Who is signed in, and how a guest becomes a Ranked player. Ranked needs a real account (Google or a Phantom wallet);
// everything else (Social, offline) keeps working with the anonymous guest session.
import { getSolanaAddress, type WalletUser } from '../../wallet/phantom';

/** localStorage key set just before leaving for Google, so the game can reopen Ranked when the browser comes back. */
export const RETURN_KEY = 'pokejam.signin.return';

export interface AccountUser extends WalletUser {
  is_anonymous?: boolean;
  email?: string;
}
export type AccountKind = 'guest' | 'google' | 'phantom' | 'member';
export interface Account { kind: AccountKind; /** Short text for the chip: an email, "7Ecd…LtV", "Guest". */ label: string }

const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function accountOf(user: AccountUser | null | undefined): Account {
  if (!user || user.is_anonymous) return { kind: 'guest', label: 'Guest' };
  const sol = getSolanaAddress(user);
  if (sol) return { kind: 'phantom', label: shortAddress(sol) };
  const providers = [user.app_metadata?.provider, ...(user.app_metadata?.providers ?? []), ...(user.identities ?? []).map((i) => i.provider)];
  if (providers.includes('google')) return { kind: 'google', label: user.email ?? 'Google account' };
  return { kind: 'member', label: user.email ?? 'Signed in' };
}

/** Ranked is for signed-in accounts only. A missing user counts as a guest. */
export const isGuest = (user: AccountUser | null | undefined): boolean => accountOf(user).kind === 'guest';

/** Where Google sends the browser back to: this page, without the hash or a stale OAuth query. */
export function returnUrl(loc: { origin: string; pathname: string; search?: string }): string {
  const keep = new URLSearchParams(loc.search ?? '');
  for (const k of ['code', 'error', 'error_code', 'error_description']) keep.delete(k);
  const q = keep.toString();
  return `${loc.origin}${loc.pathname}${q ? `?${q}` : ''}`;
}

/** The slice of the Supabase client the sign-in uses. */
export interface AuthClient {
  auth: {
    getUser(): PromiseLike<{ data: { user: AccountUser | null } }>;
    linkIdentity(c: { provider: 'google'; options?: { redirectTo?: string } }): PromiseLike<{ error: { message: string } | null }>;
    signInWithOAuth(c: { provider: 'google'; options?: { redirectTo?: string } }): PromiseLike<{ error: { message: string } | null }>;
  };
}
type Store = Pick<Storage, 'setItem' | 'removeItem'> | null;
const localStore = (): Store => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

/**
 * Sign in with Google. A guest links Google to the guest account (linkIdentity), so their stats and name carry over; if
 * Supabase refuses that (manual linking off, or this Google account already has a PokeJam account) it falls back to a plain
 * Google sign-in, which opens that account instead. Either way the browser leaves for Google and comes back to this page.
 */
export async function signInWithGoogle(sb: AuthClient, loc: { origin: string; pathname: string; search?: string }, store: Store = localStore(), returnTo: 'ranked' | 'profile' = 'ranked'): Promise<void> {
  const options = { redirectTo: returnUrl(loc) };
  try { store?.setItem(RETURN_KEY, returnTo); } catch { /* storage unavailable: the player just lands on the menu */ }
  const { data } = await sb.auth.getUser();
  if (data.user?.is_anonymous) {
    const linked = await sb.auth.linkIdentity({ provider: 'google', options });
    if (!linked.error) return;
  }
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options });
  if (error) {
    try { store?.removeItem(RETURN_KEY); } catch { /* ignore */ }
    throw new Error(error.message || 'Could not start Google sign-in.');
  }
}
