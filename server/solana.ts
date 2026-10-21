// Minimal Solana JSON-RPC client: just what deposits and payouts need.

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
  confirmationStatus?: string;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface ParsedTransaction {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } };
}

export class Rpc {
  private id = 0;
  constructor(private url: string) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
    return body.result as T;
  }

  /** Newest first. `until` stops before that signature (exclusive). */
  signaturesFor(address: string, opts: { until?: string; before?: string; limit?: number; commitment?: string }) {
    return this.call<SignatureInfo[]>('getSignaturesForAddress', [address, { limit: 100, ...opts }]);
  }

  transaction(signature: string, commitment: string) {
    return this.call<ParsedTransaction | null>('getTransaction', [signature, { encoding: 'jsonParsed', commitment, maxSupportedTransactionVersion: 0 }]);
  }

  /** Token account balance in base units. */
  async tokenBalance(account: string): Promise<number> {
    const r = await this.call<{ value: { amount: string } }>('getTokenAccountBalance', [account, { commitment: 'confirmed' }]);
    return Number(r.value.amount);
  }
}

/**
 * The USDC this transaction moved into `account`, and who it came from: the owner whose USDC balance
 * dropped the most. Null when nothing arrived.
 */
export function usdcReceived(tx: ParsedTransaction, account: string, mint: string): { amount: number; sender: string | null } | null {
  if (!tx.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const idx = keys.indexOf(account);
  if (idx < 0) return null;
  const amt = (list: TokenBalance[] | undefined, i: number) => Number(list?.find((b) => b.accountIndex === i && b.mint === mint)?.uiTokenAmount.amount ?? 0);
  const received = amt(tx.meta.postTokenBalances, idx) - amt(tx.meta.preTokenBalances, idx);
  if (!(received > 0)) return null;
  let sender: string | null = null;
  let biggest = 0;
  for (const pre of tx.meta.preTokenBalances ?? []) {
    if (pre.mint !== mint || pre.accountIndex === idx || !pre.owner) continue;
    const drop = Number(pre.uiTokenAmount.amount) - amt(tx.meta.postTokenBalances, pre.accountIndex);
    if (drop > biggest) { biggest = drop; sender = pre.owner; }
  }
  return { amount: received, sender };
}
