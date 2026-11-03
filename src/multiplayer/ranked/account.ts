// Who is signed in, and how a guest becomes a Ranked player. Ranked needs a real account (Discord or a Phantom wallet);
// everything else (Social, offline) keeps working with the anonymous guest session.
// Discord is a plain signInWithOAuth. It does not link the guest account. A wallet is linked later, only for payments.
import { getSolanaAddress, type WalletUser } from '../../wallet/phantom';

/** localStorage key set just before leaving for Discord, so the game can reopen Ranked when the browser comes back. */
export const RETURN_KEY = 'pokejam.signin.return';

export interface AccountUser extends WalletUser {
  is_anonymous?: boolean;
  email?: string;
}
export type AccountKind = 'guest' | 'discord' | 'phantom' | 'member';
export interface Account { kind: AccountKind; /** Short text for the chip: an email, "7Ecd…LtV", "Guest". */ label: string }

const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function accountOf(user: AccountUser | null | undefined): Account {
  if (!user || user.is_anonymous) return { kind: 'guest', label: 'Guest' };
  const sol = getSolanaAddress(user);
  if (sol) return { kind: 'phantom', label: shortAddress(sol) };
  const providers = [user.app_metadata?.provider, ...(user.app_metadata?.providers ?? []), ...(user.identities ?? []).map((i) => i.provider)];
  // The email and the Discord name stay off every label. The public name is the username picked in game.
  if (providers.includes('discord')) return { kind: 'discord', label: 'Discord' };
  return { kind: 'member', label: 'Signed in' };
}

/** Ranked is for signed-in accounts only. A missing user counts as a guest. */
export const isGuest = (user: AccountUser | null | undefined): boolean => accountOf(user).kind === 'guest';

/** Where Discord sends the browser back to: this page, without the hash or a stale OAuth query. */
export function returnUrl(loc: { origin: string; pathname: string; search?: string }): string {
  const keep = new URLSearchParams(loc.search ?? '');
  for (const k of ['code', 'error', 'error_code', 'error_description']) keep.delete(k);
  const q = keep.toString();
  return `${loc.origin}${loc.pathname}${q ? `?${q}` : ''}`;
}

/** The slice of the Supabase client the sign-in uses. */
export interface AuthClient {
  auth: {
    signInWithOAuth(c: { provider: 'discord'; options?: { redirectTo?: string; scopes?: string } }): PromiseLike<{ error: { message: string } | null }>;
  };
}
type Store = Pick<Storage, 'setItem' | 'removeItem'> | null;
const localStore = (): Store => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

/**
 * Sign in with Discord in this tab (Safari, Chrome, desktop). The browser leaves for Discord and comes back to this page.
 * A home-screen app does not call this: the return would land in Safari without the PKCE verifier. That path is discordHandoff.ts.
 */
export async function signInWithDiscord(sb: AuthClient, loc: { origin: string; pathname: string; search?: string }, store: Store = localStore(), returnTo: 'ranked' | 'profile' = 'ranked'): Promise<void> {
  const options = { redirectTo: returnUrl(loc), scopes: 'identify email' };
  try { store?.setItem(RETURN_KEY, returnTo); } catch { /* storage unavailable: the player just lands on the menu */ }
  const { error } = await sb.auth.signInWithOAuth({ provider: 'discord', options });
  if (error) {
    try { store?.removeItem(RETURN_KEY); } catch { /* ignore */ }
    throw new Error(error.message || 'Could not start Discord sign-in.');
  }
}
