// Minimal Solana JSON-RPC client: just what payouts need. `fetch` is injectable for tests.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class Rpc {
  private id = 0;
  constructor(private url: string, private fetchFn: Fetch = (i, init) => fetch(i, init)) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
    return body.result as T;
  }

  async latestBlockhash(): Promise<string> {
    const r = await this.call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return r.value.blockhash;
  }

  /** The account's owning program and raw data (base64), or null when it doesn't exist. */
  async accountInfo(address: string): Promise<{ owner: string; data: string } | null> {
    const r = await this.call<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
    return r.value ? { owner: r.value.owner, data: r.value.data[0] } : null;
  }

  send(base64Tx: string): Promise<string> {
    return this.call<string>('sendTransaction', [base64Tx, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  }

  /** Wait until `signature` is confirmed (true) or failed (throws), up to `timeoutMs`. */
  async confirm(signature: string, timeoutMs = 60_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await this.call<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const s = r.value[0];
      if (s?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(s.err)}`);
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return true;
      await new Promise((res) => setTimeout(res, 1500));
    }
    return false;
  }

  /** Token account balance in base units. */
  async tokenBalance(account: string): Promise<number> {
    const r = await this.call<{ value: { amount: string } }>('getTokenAccountBalance', [account, { commitment: 'confirmed' }]);
    return Number(r.value.amount);
  }
}
