// The pokejam-ads Edge Function (supabase/functions/_shared/ads/handler.ts). The page never moves tokens itself:
// the server builds the burn, the advertiser's wallet signs it, the server checks it on-chain.
import type { AdTheme } from '../data/ads';

export type Plan = 'hour' | 'day' | 'week';
export const PLANS: Plan[] = ['hour', 'day', 'week'];
export const PLAN_HOURS: Record<Plan, number> = { hour: 1, day: 24, week: 168 };

export interface LiveAd { id: string; text: string; theme: AdTheme; wallet: string; starts_at: string; ends_at: string; burn_sig: string }

export interface Board {
  now: string;
  paused: boolean;
  spots: number;
  prices: Record<Plan, string>;
  live: LiveAd[];
  booked: { starts_at: string; ends_at: string }[];
  totals: { burned: string; ads: number; advertisers: number; hours: number };
  cluster: 'devnet' | 'mainnet-beta';
  mint: string;
  decimals: number;
  supply: string;
  faucet: boolean;
}

export interface Quote { plan: Plan; hours: number; price: string; starts_at: string; ends_at: string; moved: boolean }

export interface Booking {
  id: string;
  code: string;
  wallet: string;
  text: string;
  theme: AdTheme;
  plan: Plan;
  hours: number;
  price: string;
  state: 'pending' | 'paid' | 'dust' | 'removed';
  starts_at: string | null;
  ends_at: string | null;
  moved: boolean;
  burn_sig: string | null;
  created_at: string;
  extra_of: string | null;
  replaces: string | null;
  replaced_by: string | null;
  removed_reason: string | null;
  /** Seconds of airtime left when moderators took it down: the advertiser can run it with new text. */
  removed_left: number | null;
  banned: boolean;
}

/** What confirm says: settled, still landing, or definitely not burned. */
export interface Confirmed { booking: Booking; landing?: boolean; expired?: boolean; notBurned?: boolean; error?: string }

export class AdsError extends Error {
  constructor(message: string, readonly info: Record<string, unknown> = {}) { super(message); }
}

const URL_ = import.meta.env.VITE_ADS_API
  || (import.meta.env.VITE_SUPABASE_URL ? `${import.meta.env.VITE_SUPABASE_URL.replace(/\/$/, '')}/functions/v1/pokejam-ads` : '');
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const ADS_CONFIGURED = !!URL_;

async function call<T>(body: Record<string, unknown> | null): Promise<T> {
  const headers: Record<string, string> = {};
  // The Supabase gateway wants the publishable key; it's public by design.
  if (KEY && !import.meta.env.VITE_ADS_API) { headers.apikey = KEY; headers.authorization = `Bearer ${KEY}`; }
  let res: Response;
  try {
    res = body
      ? await fetch(URL_, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      : await fetch(`${URL_}?action=board`, { headers });
  } catch {
    throw new AdsError('Could not reach the ad server. Check your connection.');
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok || data.error) throw new AdsError(data.error ?? `HTTP ${res.status}`, data as Record<string, unknown>);
  return data;
}

async function confirmCall(id: string, proof: { signature?: string; tx?: string }): Promise<Confirmed> {
  try {
    return await call<Confirmed>({ action: 'confirm', id, ...proof });
  } catch (e) {
    const info = e instanceof AdsError ? (e.info as Partial<Confirmed>) : {};
    if (info.booking) return { ...info, booking: info.booking, error: (e as Error).message };
    throw e;
  }
}

/** What the advertiser signs to put new text on an ad moderators took down (the server checks the same string). */
export const replaceMessage = (id: string, text: string, theme: string) => `Poke Jam ad ${id}: replace the text with "${text}" in ${theme}`;

export const adsApi = {
  board: () => call<Board>(null),
  quote: (plan: Plan, start: string | null) => call<Quote>({ action: 'quote', plan, start }),
  wallet: (wallet: string) => call<{ balance: string; lamports: number; decimals: number }>({ action: 'wallet', wallet }),
  check: (text: string) => call<{ ok: boolean; reason: string | null; message: string | null }>({ action: 'check', text }),
  prepare: (a: { wallet: string; text: string; theme: AdTheme; plan: Plan; start: string | null; expect: string }) =>
    call<{ booking: Booking; tx: string; cluster: Board['cluster'] }>({ action: 'prepare', ...a }),
  /** Never throws for a burn that didn't pay: the answer says what happened (expired, notBurned, error). */
  confirm: (id: string, proof: { signature?: string; tx?: string } = {}) => confirmCall(id, proof),
  mine: (wallet: string) => call<{ ads: Booking[] }>({ action: 'mine', wallet }),
  replace: (id: string, text: string, theme: AdTheme, signature: string) => call<{ booking: Booking }>({ action: 'replace', id, text, theme, signature }),
  report: (id: string, reason: 'offensive' | 'scam' | 'other') => call<{ ok: true }>({ action: 'report', id, reason }),
  faucet: (wallet: string) => call<{ signature: string; amount: string }>({ action: 'faucet', wallet }),
};

/** Base units → "1,500,000" (whole tokens; fractions only when there are any). */
export function tokens(base: string | bigint, decimals = 6): string {
  const v = BigInt(base);
  const unit = 10n ** BigInt(decimals);
  const whole = (v / unit).toLocaleString('en-US');
  const frac = v % unit;
  return frac ? `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, 2)}` : whole;
}

/** "1.5M", "100K": short amounts for tight spots. */
export function shortTokens(base: string | bigint, decimals = 6): string {
  const n = Number(BigInt(base) / 10n ** BigInt(decimals));
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export const explorer = (kind: 'tx' | 'address' | 'token', id: string, cluster: Board['cluster']) =>
  `https://solscan.io/${kind}/${encodeURIComponent(id)}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
