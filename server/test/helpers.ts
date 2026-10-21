// Test helpers: config, transaction builder, and fake Collector Crypt / Solana RPC servers.

import type { Config } from '../config';
import { loadConfig } from '../config';
import { base58Decode, base58Encode, base64Decode, base64Encode, randomBytes } from '../lib/bytes';
import { generateKeypair, verifySignature, type Keypair } from '../lib/ed25519';
import { parseTransaction, serializeTransaction } from '../lib/solana-tx';

export function testConfig(over: Partial<Config> = {}): Config {
  return { ...loadConfig(), dbPath: ':memory:', clientOrigins: ['*'], restrictedRegions: [], pickSeconds: 1, forfeitSeconds: 2, acceptTimeoutSeconds: 30, rateLimitPerMinute: 1e9, ...over };
}

const compact = (n: number) => {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};

/**
 * A minimal transaction (no instructions) whose first signers are `signers`, as real Solana wire bytes.
 * `v0` builds a versioned message.
 */
export function buildTx(signers: string[], extraKeys = 1, v0 = false): Uint8Array {
  const keys = [...signers, ...Array.from({ length: extraKeys }, () => base58Encode(randomBytes(32)))];
  const msg = [
    ...(v0 ? [0x80] : []),
    signers.length, 0, extraKeys,
    ...compact(keys.length), ...keys.flatMap((k) => [...base58Decode(k)]),
    ...randomBytes(32), // recent blockhash
    ...compact(0), // no instructions
    ...(v0 ? compact(0) : []), // no address table lookups
  ];
  return new Uint8Array([...compact(signers.length), ...new Array(64 * signers.length).fill(0), ...msg]);
}

/** Sign `tx` (bytes) as `kp`, the way Collector Crypt's gacha wallet partially signs before handing it over. */
export async function partialSign(tx: Uint8Array, kp: Keypair): Promise<Uint8Array> {
  const p = parseTransaction(tx);
  p.signatures[p.signers.indexOf(kp.address)] = await kp.sign(p.message);
  return serializeTransaction(p);
}

export async function allSignaturesValid(tx: Uint8Array): Promise<boolean> {
  const p = parseTransaction(tx);
  for (let i = 0; i < p.signers.length; i++) if (!(await verifySignature(p.signers[i], p.message, p.signatures[i]))) return false;
  return true;
}

/** A fake Collector Crypt gacha API that checks every submitted transaction is fully and validly signed. */
export async function fakeCollectorCrypt(houseAddress: string, opts: { failGenerate?: number; failOpenAfterPay?: number } = {}) {
  const gacha = (await generateKeypair()).keypair;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const memos = new Map<string, { paid: boolean; recipient: string }>();
  let failGenerate = opts.failGenerate ?? 0;
  let failOpen = opts.failOpenAfterPay ?? 0;
  let n = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === 'POST' ? (await req.json()) as Record<string, unknown> : {};
      calls.push({ path, body });
      const ok = (d: unknown, status = 200) => Response.json(d, { status });
      if (path === '/api/generateGift' || path === '/api/generatePack') {
        if (failGenerate > 0) { failGenerate--; return ok({ error: 'Machine is low', details: 'Machine is low' }, 500); }
        const memo = `pj-${++n}`;
        const payer = String(path === '/api/generateGift' ? body.sender : body.playerAddress);
        if (payer !== houseAddress) return ok({ error: 'wrong payer' }, 400);
        memos.set(memo, { paid: false, recipient: String(path === '/api/generateGift' ? body.receiver : body.altPlayerAddress) });
        const tx = await partialSign(buildTx([payer, gacha.address]), gacha);
        return ok({ memo, transaction: base64Encode(tx), giftId: `g${n}`, totalCost: 25 });
      }
      if (path === '/api/submitTransaction') {
        const tx = base64Decode(String(body.signedTransaction));
        if (!(await allSignaturesValid(tx))) return ok({ error: 'bad signatures' }, 403);
        for (const m of memos.values()) if (!m.paid) { m.paid = true; break; }
        return ok({ success: true, signature: 'sig' + n, confirmationStatus: 'confirmed' });
      }
      if (path === '/api/openPack') {
        const m = memos.get(String(body.memo));
        if (!m?.paid) return ok({ error: 'No spin transaction found for memo' }, 404);
        if (failOpen > 0) { failOpen--; return ok({ error: 'processing error' }, 500); }
        return ok({ success: true, rarity: 'Rare', nft_address: 'NFT' + body.memo, roll: 0.42 });
      }
      return ok({ error: 'not found' }, 404);
    },
  });
  return { url: `http://localhost:${server.port}`, calls, memos, stop: () => server.stop(true) };
}

/** A fake Solana RPC that serves whatever transactions and balances the test sets. */
export function fakeRpc() {
  const sigs: { signature: string; slot: number; err: null }[] = [];
  const txs = new Map<string, unknown>();
  let balance = 1e12;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { id, method, params } = (await req.json()) as { id: number; method: string; params: unknown[] };
      const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
      if (method === 'getSignaturesForAddress') {
        const opts = (params[1] ?? {}) as { until?: string; before?: string };
        let list = [...sigs].reverse();
        if (opts.until) {
          const at = list.findIndex((s) => s.signature === opts.until);
          if (at >= 0) list = list.slice(0, at);
        }
        return reply(list);
      }
      if (method === 'getTransaction') return reply(txs.get(String(params[0])) ?? null);
      if (method === 'getTokenAccountBalance') return reply({ value: { amount: String(balance) } });
      return Response.json({ jsonrpc: '2.0', id, error: { message: 'unknown method' } });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    setBalance: (b: number) => { balance = b; },
    /** Add a USDC transfer of `amount` base units from `sender` into `houseAccount`. */
    deposit(signature: string, sender: string, houseAccount: string, mint: string, amount: number) {
      sigs.push({ signature, slot: sigs.length + 1, err: null });
      const senderAta = base58Encode(randomBytes(32));
      txs.set(signature, {
        slot: sigs.length, blockTime: Math.floor(Date.now() / 1000),
        meta: {
          err: null,
          preTokenBalances: [
            { accountIndex: 1, mint, owner: sender, uiTokenAmount: { amount: String(amount * 3), decimals: 6 } },
            { accountIndex: 2, mint, owner: 'HOUSE', uiTokenAmount: { amount: '0', decimals: 6 } },
          ],
          postTokenBalances: [
            { accountIndex: 1, mint, owner: sender, uiTokenAmount: { amount: String(amount * 2), decimals: 6 } },
            { accountIndex: 2, mint, owner: 'HOUSE', uiTokenAmount: { amount: String(amount), decimals: 6 } },
          ],
        },
        transaction: { message: { accountKeys: [{ pubkey: sender }, { pubkey: senderAta }, { pubkey: houseAccount }] } },
      });
    },
    stop: () => server.stop(true),
  };
}

/** A signed-in player for API tests. */
export async function signIn(base: string) {
  const { keypair } = await generateKeypair();
  const { message } = (await (await fetch(`${base}/api/auth/nonce?wallet=${keypair.address}`)).json()) as { message: string };
  const sig = await keypair.sign(new TextEncoder().encode(message));
  const res = (await (await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet: keypair.address, message, signature: base58Encode(sig) }),
  })).json()) as { token: string };
  const api = async <T = unknown>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; data: T }> => {
    const r = await fetch(base + path, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { authorization: `Bearer ${init.token ?? res.token}`, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: r.status, data: (await r.json()) as T };
  };
  return { wallet: keypair.address, token: res.token, api, keypair };
}
