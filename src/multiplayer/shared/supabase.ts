// The Supabase client for online play, created on first use. Configured by VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY (the publishable key, public by design). Players get an anonymous account.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CAPTCHA_ON, captchaToken } from './captcha';

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const ONLINE_CONFIGURED = !!URL && !!KEY;

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!ONLINE_CONFIGURED) throw new Error('Online play is not configured for this build.');
  client ??= createClient(URL!, KEY!, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pokejam.auth' },
    realtime: { params: { eventsPerSecond: 40 } },
  });
  return client;
}

/** Signs in (anonymously the first time; the account is kept on this device) and returns the user id. */
export async function ensureSignedIn(sb: SupabaseClient): Promise<string> {
  const { data } = await sb.auth.getSession();
  if (data.session?.user) return data.session.user.id;
  const { data: anon, error } = await sb.auth.signInAnonymously(CAPTCHA_ON ? { options: { captchaToken: await captchaToken() } } : undefined);
  if (error || !anon.user) throw new Error(error?.message ?? 'Could not sign in');
  return anon.user.id;
}
