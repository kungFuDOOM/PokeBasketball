// The real Pack Battles backend: the server in server/, reached over HTTPS and a WebSocket.

import { ApiError, type Backend } from '../battles/backend';
import type { PackTier } from '../battles/service';
import { hex, randomBytes } from './bytes';
import type { BattleView, DepositView, Me, PrizeView, PublicConfig, WithdrawalView } from './protocol';
import { connect, signMessage, type WalletOption } from './wallet';

const SESSION = 'pokejam.session';
const SEEDS = 'pokejam.seeds';

/** The server's URL: set VITE_API_URL at build time, or ?api=https://… once to point a build at a server. */
export function apiBase(): string | null {
  const q = new URLSearchParams(location.search).get('api');
  try {
    if (q) localStorage.setItem('pokejam.api', q);
    return q || localStorage.getItem('pokejam.api') || (import.meta.env.VITE_API_URL as string | undefined) || null;
  } catch {
    return q || (import.meta.env.VITE_API_URL as string | undefined) || null;
  }
}

export class HttpBackend implements Backend {
  readonly online = true;
  private token: string | null = null;
  private cfg: PublicConfig | null = null;

  constructor(readonly base: string) {
    this.base = base.replace(/\/$/, '');
    try {
      const s = JSON.parse(localStorage.getItem(SESSION) ?? 'null') as { base: string; token: string; expiresAt: number } | null;
      if (s && s.base === this.base && s.expiresAt > Date.now()) this.token = s.token;
    } catch { /* no saved session */ }
  }

  get signedIn() {
    return !!this.token;
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError("Can't reach the Pack Battles server. Check your connection and try again.");
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (res.status === 401 && this.token && !path.startsWith('/api/auth')) this.forget();
    if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
    return data;
  }

  private forget() {
    this.token = null;
    try { localStorage.removeItem(SESSION); } catch { /* ignore */ }
  }

  async config() {
    this.cfg ??= await this.call<PublicConfig>('/api/config');
    return this.cfg;
  }

  async signIn(w: WalletOption): Promise<Me> {
    const wallet = await connect(w);
    const { message } = await this.call<{ message: string }>(`/api/auth/nonce?wallet=${encodeURIComponent(wallet)}`);
    const signature = await signMessage(w, message);
    const s = await this.call<{ token: string; expiresAt: number }>('/api/auth/login', { wallet, message, signature });
    this.token = s.token;
    try { localStorage.setItem(SESSION, JSON.stringify({ base: this.base, token: s.token, expiresAt: s.expiresAt })); } catch { /* ignore */ }
    return (await this.me())!;
  }

  async signOut() {
    if (this.token) await this.call('/api/auth/logout', {}).catch(() => {});
    this.forget();
  }

  async me() {
    if (!this.token) return null;
    try {
      return await this.call<Me>('/api/me');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  }

  open = () => this.call<BattleView[]>('/api/battles/open');
  mine = () => this.call<BattleView[]>('/api/battles/mine');
  prizes = () => this.call<PrizeView[]>('/api/prizes');
  deposits = () => this.call<DepositView[]>('/api/deposits');
  withdrawals = () => this.call<WithdrawalView[]>('/api/withdrawals');
  battle = (id: string) => this.call<BattleView>(`/api/battles/${id}`);
  setEligibility = (adult: boolean, region: string) => this.call<Me>('/api/me/eligibility', { adult, region });
  setTeamName = (teamName: string) => this.call<Me>('/api/me/team', { teamName });
  scanDeposits = () => this.call<Me>('/api/deposits/scan', {});
  withdraw = (amount: number, address?: string) => this.call<Me>('/api/withdrawals', { amount, address });

  /** Your own seed for a battle, kept so you can check the proof afterwards. */
  private seedFor(key: string): string {
    const s = hex(randomBytes(16));
    try {
      const all = JSON.parse(localStorage.getItem(SEEDS) ?? '{}') as Record<string, string>;
      all[key] = s;
      localStorage.setItem(SEEDS, JSON.stringify(all));
    } catch { /* ignore */ }
    return s;
  }

  create = (tier: PackTier, quarterLen: number) => this.call<BattleView>('/api/battles', { tier, quarterLen, clientSeed: this.seedFor(`new:${Date.now()}`) });
  accept = (id: string) => this.call<BattleView>(`/api/battles/${id}/accept`, { clientSeed: this.seedFor(id) });
  cancel = async (id: string) => { await this.call(`/api/battles/${id}/cancel`, {}); };

  socketUrl(battleId: string): string {
    const u = new URL(this.base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = new URLSearchParams({ token: this.token ?? '', battle: battleId }).toString();
    return u.toString();
  }

  proofUrl = (battleId: string) => `${this.base}/api/battles/${battleId}/proof`;
}
