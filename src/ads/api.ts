// The live site's ads Edge Function, pokejam-ads-live (supabase/functions/pokejam-ads-live, sharing
// _shared/ads/handler.ts with the devnet test site's function). The page never moves tokens itself: the server builds the
// burn or the USDC transfer, the advertiser's wallet signs it, the server checks it on-chain.
import type { AdTheme } from '../data/ads';
import type { UsdcPlan } from './usdcPay';

export type Plan = 'hour' | 'day' | 'week';
export const PLANS: Plan[] = ['hour', 'day', 'week'];
export const PLAN_HOURS: Record<Plan, number> = { hour: 1, day: 24, week: 168 };

export interface LiveAd { id: string; text: string; theme: AdTheme; wallet: string; starts_at: string; ends_at: string; burn_sig: string | null; usdc_sig?: string | null }

export interface Board {
  now: string;
  paused: boolean;
  spots: number;
  prices: Record<Plan, string>;
  live: LiveAd[];
  booked: { starts_at: string; ends_at: string }[];
  /** USDC base units per plan (live only). */
  usdc?: Record<UsdcPlan, string>;
  /** Where USDC payments go (live only; absent means USDC isn't offered). */
  usdcPay?: { mint: string; receiver: string; decimals: number };
  totals: { burned: string; usdc?: string; ads: number; advertisers: number; hours: number };
  cluster: 'devnet' | 'mainnet-beta';
  mint: string;
  decimals: number;
  supply: string;
  /** Always false on the live function's mainnet; the live page never offers a faucet either way. */
  faucet: boolean;
}

/** `price`: PJAM to burn (null for a USDC-only plan); `usdc`: USDC base units (null when it can't be paid in USDC). */
export interface Quote { plan: Plan | UsdcPlan; hours: number; price: string | null; usdc?: string | null; starts_at: string; ends_at: string; moved: boolean }

export interface Booking {
  id: string;
  code: string;
  wallet: string;
  text: string;
  theme: AdTheme;
  plan: Plan | UsdcPlan;
  hours: number;
  pay_method?: 'burn' | 'usdc';
  price: string;
  state: 'pending' | 'paid' | 'dust' | 'removed';
  starts_at: string | null;
  ends_at: string | null;
  moved: boolean;
  burn_sig: string | null;
  usdc_sig?: string | null;
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

/** The live function's URL: VITE_ADS_API when set (local development), else the Supabase project's pokejam-ads-live. */
export const adsUrl = (env: { VITE_ADS_API?: string; VITE_SUPABASE_URL?: string }) => env.VITE_ADS_API
  || (env.VITE_SUPABASE_URL ? `${env.VITE_SUPABASE_URL.replace(/\/$/, '')}/functions/v1/pokejam-ads-live` : '');
const URL_ = adsUrl(import.meta.env);
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
  quote: (plan: Plan | UsdcPlan, start: string | null) => call<Quote>({ action: 'quote', plan, start }),
  wallet: (wallet: string) => call<{ balance: string; lamports: number; decimals: number }>({ action: 'wallet', wallet }),
  check: (text: string) => call<{ ok: boolean; reason: string | null; message: string | null }>({ action: 'check', text }),
  prepare: (a: { wallet: string; text: string; theme: AdTheme; plan: Plan; start: string | null; expect: string }) =>
    call<{ booking: Booking; tx: string; cluster: Board['cluster'] }>({ action: 'prepare', ...a }),
  /** Never throws for a burn that didn't pay: the answer says what happened (expired, notBurned, error). */
  confirm: (id: string, proof: { signature?: string; tx?: string } = {}) => confirmCall(id, proof),
  mine: (wallet: string) => call<{ ads: Booking[] }>({ action: 'mine', wallet }),
  replace: (id: string, text: string, theme: AdTheme, signature: string) => call<{ booking: Booking }>({ action: 'replace', id, text, theme, signature }),
  report: (id: string, reason: 'offensive' | 'scam' | 'other') => call<{ ok: true }>({ action: 'report', id, reason }),
  /** Pay in USDC: checks the ad (text, ban, price), then a one-time intent and the unsigned transfer to sign. */
  usdcIntent: (a: { wallet: string; text: string; theme: AdTheme; plan: UsdcPlan; start: string | null; expect: string }) =>
    call<Record<string, unknown>>({ action: 'usdc-intent', ...a }),
  /** 200 {status:'paid', ad}, 202 {status:'pending'|'open'}; a refusal throws AdsError (info.code, info.expired, info.notPaid). */
  usdcConfirm: (id: string, proof: { signature?: string; tx?: string } = {}) =>
    call<{ status: 'paid' | 'pending' | 'open'; duplicate?: boolean; ad?: Booking | null }>({ action: 'usdc-confirm', id, ...proof }),
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
