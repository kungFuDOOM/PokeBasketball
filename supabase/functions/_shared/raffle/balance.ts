// PJAM held by a linked wallet, in whole tokens. Read at draw time. The raw balance is divided by 10^decimals
// from the mint account, so a change of decimals cannot be hardcoded wrong. Finalized, so a flash balance
// that has not settled does not count.

export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface Rpc { call<T>(method: string, params: unknown[]): Promise<T> }

interface MintInfo { value: { data: { parsed?: { info?: { decimals?: number } } } } | null }
interface TokenAccount { pubkey: string; account: { data: { parsed?: { info?: { mint?: string; state?: string; tokenAmount?: { amount?: string } } } } } }
interface TokenList { value: TokenAccount[] }

export function wholeTokens(raw: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('bad decimals');
  let unit = 1n;
  for (let i = 0; i < decimals; i++) unit *= 10n;
  return raw / unit;
}

const readAmount = (a: TokenAccount, mint: string): bigint | null => {
  const info = a.account?.data?.parsed?.info;
  if (!info?.tokenAmount?.amount) throw new Error('token account was not parsed');
  if (info.mint && info.mint !== mint) return null;
  if (info.state === 'frozen') return null;
  return BigInt(info.tokenAmount.amount);
};

/** Whole PJAM for one wallet. Empty and frozen accounts are zero. A missing mint throws. */
export async function walletWhole(rpc: Rpc, mint: string, wallet: string): Promise<bigint> {
  const info = await rpc.call<MintInfo>('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'finalized' }]);
  const decimals = info.value?.data?.parsed?.info?.decimals;
  if (decimals === undefined) throw new Error('mint not found');
  const [byMint, ext] = await Promise.all([
    rpc.call<TokenList>('getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed', commitment: 'finalized' }]),
    rpc.call<TokenList>('getTokenAccountsByOwner', [wallet, { programId: TOKEN_2022 }, { encoding: 'jsonParsed', commitment: 'finalized' }]),
  ]);
  const seen = new Set<string>();
  let raw = 0n;
  for (const a of [...(byMint.value ?? []), ...(ext.value ?? [])]) {
    if (seen.has(a.pubkey)) continue;
    seen.add(a.pubkey);
    const n = readAmount(a, mint);
    if (n !== null) raw += n;
  }
  return wholeTokens(raw, decimals);
}

/** user id -> whole tokens, decimal string. Wallets are read a few at a time. A null wallet is zero. */
export async function pjamWholes(rpc: Rpc, mint: string, rows: { user_id: string; wallet: string | null }[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const pending = rows.filter((r) => r.wallet);
  for (const r of rows) if (!r.wallet) out[r.user_id] = '0';
  for (let i = 0; i < pending.length; i += 4) {
    const slice = pending.slice(i, i + 4);
    const wholes = await Promise.all(slice.map((r) => walletWhole(rpc, mint, r.wallet!)));
    slice.forEach((r, n) => { out[r.user_id] = wholes[n]!.toString(); });
  }
  return out;
}
