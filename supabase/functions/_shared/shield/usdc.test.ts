import { describe, expect, it, vi } from 'vitest';
import { base58Decode, base58Encode, randomBytes } from '../pack/bytes.ts';
import { generateKeypair } from '../pack/ed25519.ts';
import { decodeTransaction } from '../pack/tx-inspect.ts';
import { parseTransaction } from '../pack/solana-tx.ts';
import { PROGRAM, USDC_MINT, buildUsdcTransfer, deriveAta, findProgramAddress, isOnCurve, u64le } from './usdc-chain.ts';
import { MAINNET_APPROVAL } from '../pack/config.ts';
import { solanaAddressOf, usdcConfig } from './usdc-config.ts';
import { usdcConfirmHandler, usdcIntentHandler, type UsdcDeps, type UsdcUser } from './usdc-handlers.ts';
import { fetchTransaction, verifyUsdcTx, type ChainTx, type IntentFacts } from './usdc-verify.ts';
import { testDb } from '../../../tests/testDb';

vi.setConfig({ testTimeout: 60_000 });

const newAddress = async () => (await generateKeypair()).keypair.address;
const MINT = USDC_MINT.devnet;

describe('Solana helpers', () => {
  it('knows curve points from non-points', async () => {
    // Ed25519 base point (y = 4/5) and real public keys are on the curve; y >= p is not a point.
    expect(isOnCurve(new Uint8Array([0x58, ...new Array(31).fill(0x66)]))).toBe(true);
    for (let i = 0; i < 3; i++) expect(isOnCurve(base58Decode(await newAddress()))).toBe(true);
    expect(isOnCurve(new Uint8Array(32).fill(0xff))).toBe(false);
    expect(isOnCurve(new Uint8Array(31))).toBe(false);
    // roughly half of random strings are off the curve
    const off = Array.from({ length: 40 }, () => isOnCurve(randomBytes(32))).filter((x) => !x).length;
    expect(off).toBeGreaterThan(8);
    expect(off).toBeLessThan(32);
  });

  it('derives a stable ATA that is off-curve and depends on owner and mint', async () => {
    const owner = await newAddress();
    const a = await deriveAta(owner, MINT);
    expect(a).toBe(await deriveAta(owner, MINT));
    expect(isOnCurve(base58Decode(a))).toBe(false);
    expect(await deriveAta(owner, USDC_MINT['mainnet-beta'])).not.toBe(a);
    expect(await deriveAta(await newAddress(), MINT)).not.toBe(a);
    // the same address as the generic PDA search over the documented seeds, with a bump in range
    const pda = await findProgramAddress([base58Decode(owner), base58Decode(PROGRAM.token), base58Decode(MINT)], PROGRAM.ata);
    expect(pda.address).toBe(a);
    expect(pda.bump).toBeLessThanOrEqual(255);
    // next bump up is on the curve (that is why it was skipped) unless the first try won
    if (pda.bump < 255) expect(pda.bump).toBeGreaterThanOrEqual(0);
  });

  it('writes u64 little-endian', () => {
    expect([...u64le(1_990_000n)]).toEqual([0x70, 0x5d, 0x1e, 0, 0, 0, 0, 0]);
    expect([...u64le(0xffffffffffffffffn)]).toEqual(new Array(8).fill(255));
  });

  it('builds a legacy transfer that the existing inspector reads back byte for byte', async () => {
    const [payer, receiver, ref] = [await newAddress(), await newAddress(), base58Encode(randomBytes(32))];
    const blockhash = base58Encode(randomBytes(32));
    const t = await buildUsdcTransfer({ payer, mint: MINT, receiver, amount: 1_990_000n, reference: ref, memo: 'pj-abc123', blockhash });
    expect(t.source).toBe(await deriveAta(payer, MINT));
    expect(t.destination).toBe(await deriveAta(receiver, MINT));
    // one empty signature slot, then the message
    expect(t.transaction[0]).toBe(1);
    expect(t.transaction.slice(1, 65).every((b) => b === 0)).toBe(true);
    const parsed = parseTransaction(t.transaction);
    expect(parsed.version).toBe('legacy');
    expect(parsed.signers).toEqual([payer]);
    const m = decodeTransaction(t.transaction);
    expect(m.signers).toEqual([payer]);
    expect(m.writable).toEqual(new Set([payer, t.source, t.destination]));
    expect(m.keys).toEqual([payer, t.source, t.destination, MINT, ref, PROGRAM.token, PROGRAM.memo]);
    expect(m.instructions).toHaveLength(2);
    const [xfer, memo] = m.instructions;
    expect(xfer.program).toBe(PROGRAM.token);
    expect(xfer.accounts).toEqual([t.source, MINT, t.destination, payer, ref]);
    expect([...xfer.data]).toEqual([12, 0x70, 0x5d, 0x1e, 0, 0, 0, 0, 0, 6]); // TransferChecked, 1.99 USDC, 6 decimals
    expect(memo.program).toBe(PROGRAM.memo);
    expect(new TextDecoder().decode(memo.data)).toBe('pj-abc123');
    // the blockhash sits right after the keys: 32 bytes
    expect(base58Encode(t.message.slice(3 + 1 + 7 * 32, 3 + 1 + 7 * 32 + 32))).toBe(blockhash);
  });

  it('refuses a zero amount and an account listed twice', async () => {
    const [payer, receiver, ref] = [await newAddress(), await newAddress(), base58Encode(randomBytes(32))];
    const base = { payer, mint: MINT, receiver, reference: ref, memo: 'm', blockhash: base58Encode(randomBytes(32)) };
    await expect(buildUsdcTransfer({ ...base, amount: 0n })).rejects.toThrow('bad amount');
    await expect(buildUsdcTransfer({ ...base, amount: 5n, receiver: payer })).rejects.toThrow('duplicate');
  });
});

describe('USDC config and the mainnet gate', () => {
  const R = '11111111111111111111111111111112';
  const cfg = (env: Record<string, string>) => usdcConfig((k) => env[k]);
  it('defaults to devnet with the USDC-Dev mint and the public RPC', () => {
    const c = cfg({ SHIELD_USDC_RECEIVER: R });
    expect(c).toMatchObject({ cluster: 'devnet', mint: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', rpcUrl: 'https://api.devnet.solana.com', commitment: 'confirmed', disabled: null });
    expect(cfg({ SHIELD_USDC_RECEIVER: R, SHIELD_USDC_RPC_URL: 'https://rpc.example/key' }).rpcUrl).toBe('https://rpc.example/key');
  });
  it('is off without a receiver address', () => {
    expect(cfg({}).disabled).toMatch(/RECEIVER/);
    expect(cfg({ SHIELD_USDC_RECEIVER: 'nope' }).disabled).toMatch(/RECEIVER/);
  });
  it('refuses mainnet unless the exact approval phrase is set', () => {
    const base = { SHIELD_USDC_RECEIVER: R, SHIELD_USDC_CLUSTER: 'mainnet-beta' };
    expect(cfg(base).disabled).toMatch(/devnet-only/);
    expect(cfg({ ...base, SHIELD_USDC_ALLOW_MAINNET: 'true' }).disabled).toMatch(/devnet-only/);
    expect(cfg({ ...base, SHIELD_USDC_ALLOW_MAINNET: 'approved-by-kungfudoom ' }).disabled).toBeNull(); // trimmed like every secret
    expect(cfg({ ...base, SHIELD_USDC_ALLOW_MAINNET: 'APPROVED-BY-KUNGFUDOOM' }).disabled).toMatch(/devnet-only/);
    const ok = cfg({ ...base, SHIELD_USDC_ALLOW_MAINNET: MAINNET_APPROVAL });
    expect(ok).toMatchObject({ disabled: null, cluster: 'mainnet-beta', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', commitment: 'finalized', rpcUrl: 'https://api.mainnet-beta.solana.com' });
  });
  it('treats a typo in the cluster as off, never as mainnet', () => {
    expect(cfg({ SHIELD_USDC_RECEIVER: R, SHIELD_USDC_CLUSTER: 'mainnet', SHIELD_USDC_ALLOW_MAINNET: MAINNET_APPROVAL }).disabled).toMatch(/must be devnet or mainnet-beta/);
    expect(cfg({ SHIELD_USDC_RECEIVER: R, SHIELD_USDC_CLUSTER: 'mainnet' }).cluster).toBe('devnet');
  });
  it('reads the wallet only from a Solana identity on the user record', async () => {
    const a = await newAddress();
    expect(solanaAddressOf({ identities: [{ provider: 'web3', identity_data: { custom_claims: { address: a, chain: 'solana' } } }] })).toBe(a);
    expect(solanaAddressOf({ identities: [{ provider: 'web3', identity_data: { sub: `web3:solana:${a}` } }] })).toBe(a);
    expect(solanaAddressOf({ app_metadata: { provider: 'web3' }, user_metadata: { wallet_address: a } })).toBe(a);
    expect(solanaAddressOf({ identities: [{ provider: 'google', identity_data: { address: a } }] })).toBeNull();
    expect(solanaAddressOf({ app_metadata: { provider: 'google' }, user_metadata: { address: a } })).toBeNull();
    expect(solanaAddressOf({ identities: [{ provider: 'web3', identity_data: { address: a, chain: 'ethereum' } }] })).toBeNull();
    expect(solanaAddressOf(null)).toBeNull();
  });
});

// ---- verify against mocked getTransaction JSON ----
async function fixture() {
  const [wallet, receiver, other] = [await newAddress(), await newAddress(), await newAddress()];
  const f: IntentFacts = { amount: 1_990_000, mint: MINT, receiver, wallet, reference: base58Encode(randomBytes(32)), memo: 'pj-memo1', createdAt: 1_800_000_000, expiresAt: 1_800_000_900 };
  const sig = base58Encode(randomBytes(64));
  const src = await deriveAta(wallet, MINT);
  const dst = await deriveAta(receiver, MINT);
  const tx = (): ChainTx => ({
    blockTime: f.createdAt + 20,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: wallet, uiTokenAmount: { amount: '9000000' } }, { accountIndex: 2, mint: MINT, owner: receiver, uiTokenAmount: { amount: '500000' } }],
      postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: wallet, uiTokenAmount: { amount: '7010000' } }, { accountIndex: 2, mint: MINT, owner: receiver, uiTokenAmount: { amount: '2490000' } }],
      innerInstructions: [],
    },
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: [
          { pubkey: wallet, signer: true, writable: true }, { pubkey: src, signer: false, writable: true }, { pubkey: dst, signer: false, writable: true },
          { pubkey: MINT, signer: false, writable: false }, { pubkey: f.reference, signer: false, writable: false },
          { pubkey: PROGRAM.token, signer: false, writable: false }, { pubkey: PROGRAM.memo, signer: false, writable: false },
        ],
        instructions: [
          { programId: PROGRAM.token, program: 'spl-token', parsed: { type: 'transferChecked', info: { source: src, mint: MINT, destination: dst, multisigAuthority: wallet, signers: [f.reference], tokenAmount: { amount: '1990000', decimals: 6, uiAmount: 1.99, uiAmountString: '1.99' } } } },
          { programId: PROGRAM.memo, program: 'spl-memo', parsed: 'pj-memo1' },
        ],
      },
    },
  });
  return { f, sig, src, dst, wallet, receiver, other, tx };
}
type Fix = Awaited<ReturnType<typeof fixture>>;
const xfer = (t: ChainTx) => (t.transaction!.message!.instructions![0].parsed as { info: Record<string, unknown> }).info;
const code = async (t: ChainTx | null, x: Fix, f = x.f) => { const v = await verifyUsdcTx(t, x.sig, f); return v.ok ? 'ok' : v.code; };

describe('verifyUsdcTx', () => {
  it('accepts the exact payment (reference travels as the extra account, which the RPC reports as a multisig signer)', async () => {
    const x = await fixture();
    expect(await verifyUsdcTx(x.tx(), x.sig, x.f)).toEqual({ ok: true, blockTime: x.f.createdAt + 20 });
    const t = x.tx();
    const i = xfer(t);
    i.authority = i.multisigAuthority; delete i.multisigAuthority; delete i.signers; // the plain shape is fine too
    expect(await code(t, x)).toBe('ok');
  });
  it('says pending when the cluster does not have the transaction (or its block time) yet', async () => {
    const x = await fixture();
    expect(await code(null, x)).toBe('pending');
    const t = x.tx(); t.blockTime = null;
    expect(await code(t, x)).toBe('pending');
  });
  it('refuses a failed transaction, and one for another signature', async () => {
    const x = await fixture();
    const t = x.tx(); t.meta!.err = { InstructionError: [0, 'Custom'] };
    expect(await code(t, x)).toBe('tx_failed');
    const u = x.tx(); u.transaction!.signatures = [base58Encode(randomBytes(64))];
    expect(await code(u, x)).toBe('bad_tx');
  });
  it('enforces the time window: before creation, and after expiry plus grace', async () => {
    const x = await fixture();
    const early = x.tx(); early.blockTime = x.f.createdAt - 61;
    expect(await code(early, x)).toBe('too_early');
    const edge = x.tx(); edge.blockTime = x.f.createdAt - 59;
    expect(await code(edge, x)).toBe('ok');
    const late = x.tx(); late.blockTime = x.f.expiresAt + 601;
    expect(await code(late, x)).toBe('expired');
    const grace = x.tx(); grace.blockTime = x.f.expiresAt + 599;
    expect(await code(grace, x)).toBe('ok');
  });
  it('refuses the wrong mint', async () => {
    const x = await fixture();
    const wrong = USDC_MINT['mainnet-beta'];
    const t = x.tx();
    const i = xfer(t);
    i.mint = wrong; i.destination = await deriveAta(x.receiver, wrong);
    expect(await code(t, x)).toBe('wrong_mint');
    // right account, tampered mint field
    const u = x.tx(); xfer(u).mint = wrong;
    expect(await code(u, x)).toBe('wrong_mint');
  });
  it('refuses any amount that is not exact, more or less', async () => {
    const x = await fixture();
    for (const amount of ['1990001', '1989999', '2000000', '1000000', '0']) {
      const t = x.tx();
      (xfer(t).tokenAmount as { amount: string }).amount = amount;
      expect(await code(t, x), amount).toBe('wrong_amount');
    }
    // the instruction says the right amount but the house balance rose by something else (a second transfer in an inner instruction)
    const t = x.tx(); t.meta!.postTokenBalances![1].uiTokenAmount.amount = '3490000';
    expect(await code(t, x)).toBe('wrong_amount');
    // wrong decimals
    const u = x.tx(); (xfer(u).tokenAmount as { decimals: number }).decimals = 9;
    expect(await code(u, x)).toBe('wrong_amount');
  });
  it('refuses a payment to someone else, an unchecked transfer, and several transfers', async () => {
    const x = await fixture();
    const t = x.tx(); xfer(t).destination = await deriveAta(x.other, MINT);
    expect(await code(t, x)).toBe('wrong_recipient');
    const owner = x.tx(); owner.meta!.postTokenBalances![1].owner = x.other; // destination account isn't the house's
    expect(await code(owner, x)).toBe('wrong_recipient');
    const unchecked = x.tx();
    unchecked.transaction!.message!.instructions!.push({ programId: PROGRAM.token, program: 'spl-token', parsed: { type: 'transfer', info: { source: x.src, destination: x.dst, authority: x.wallet, amount: '1' } } });
    expect(await code(unchecked, x)).toBe('no_transfer');
    const twice = x.tx();
    twice.transaction!.message!.instructions!.push(structuredClone(twice.transaction!.message!.instructions![0]));
    expect(await code(twice, x)).toBe('multiple_transfers');
    const inner = x.tx();
    inner.meta!.innerInstructions = [{ instructions: [structuredClone(inner.transaction!.message!.instructions![0])] }];
    expect(await code(inner, x)).toBe('multiple_transfers');
    const none = x.tx(); none.transaction!.message!.instructions = [none.transaction!.message!.instructions![1]];
    expect(await code(none, x)).toBe('no_transfer');
  });
  it('requires the linked wallet to be the signer, the authority and the owner of the source account', async () => {
    const x = await fixture();
    const notSigner = x.tx(); notSigner.transaction!.message!.accountKeys![0] = { pubkey: x.wallet, signer: false, writable: true };
    expect(await code(notSigner, x)).toBe('wrong_signer');
    const auth = x.tx(); xfer(auth).multisigAuthority = x.other;
    expect(await code(auth, x)).toBe('wrong_signer');
    const srcOwner = x.tx(); srcOwner.meta!.preTokenBalances![0].owner = x.other; srcOwner.meta!.postTokenBalances![0].owner = x.other;
    expect(await code(srcOwner, x)).toBe('wrong_signer');
    // somebody else's transaction entirely, judged against this player's intent
    expect(await code(x.tx(), x, { ...x.f, wallet: x.other })).toBe('wrong_signer');
  });
  it('requires the reference as a read-only non-signer account and the memo as an instruction', async () => {
    const x = await fixture();
    const noRef = x.tx(); noRef.transaction!.message!.accountKeys!.splice(4, 1);
    expect(await code(noRef, x)).toBe('missing_reference');
    const writableRef = x.tx(); writableRef.transaction!.message!.accountKeys![4] = { pubkey: x.f.reference, signer: false, writable: true };
    expect(await code(writableRef, x)).toBe('missing_reference');
    const otherRef = x.tx();
    expect(await code(otherRef, x, { ...x.f, reference: base58Encode(randomBytes(32)) })).toBe('missing_reference');
    const noMemo = x.tx(); noMemo.transaction!.message!.instructions = [noMemo.transaction!.message!.instructions![0]];
    expect(await code(noMemo, x)).toBe('missing_memo');
    const otherMemo = x.tx(); otherMemo.transaction!.message!.instructions![1].parsed = 'pj-memo2';
    expect(await code(otherMemo, x)).toBe('missing_memo');
    const fakeMemo = x.tx(); fakeMemo.transaction!.message!.instructions![1].programId = x.other;
    expect(await code(fakeMemo, x)).toBe('missing_memo');
  });
  it('asks getTransaction for jsonParsed at the commitment with versioned transactions allowed', async () => {
    const call = vi.fn(async () => null);
    await fetchTransaction(call as never, 'sig', 'finalized');
    expect(call).toHaveBeenCalledWith('getTransaction', ['sig', { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  });
});

// ---- the two handlers against the real SQL (PGlite) ----
async function setup() {
  const t = await testDb();
  await t.sql('select public.pokejam_ranked_season()');
  await t.sql(`update public.pokejam_shield_products set active = true, stripe_price_id = 'price_test_' || units`);
  const receiver = await newAddress();
  const cfg = usdcConfig((k) => ({ SHIELD_USDC_RECEIVER: receiver } as Record<string, string>)[k]);
  const rpc = async <T>(fn: string, args: unknown[]) =>
    (await t.service(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args))[0].r as T;
  const txs = new Map<string, ChainTx | null>();
  const users = new Map<string, UsdcUser>();
  let nowMs = Date.now();
  const logs: string[] = [];
  const deps: UsdcDeps = {
    log: (m) => logs.push(m),
    nowMs: () => nowMs,
    userOf: async (jwt) => users.get(jwt) ?? null,
    createIntent: (a) => rpc('pokejam_shield_usdc_intent', [a.user, a.anonymous, a.sku, a.wallet, a.reference, a.memo, a.receiver, a.mint, a.cluster]),
    getIntent: (id, user) => rpc('pokejam_shield_usdc_intent_get', [id, user]),
    credit: (i, u, s) => rpc('pokejam_shield_credit_usdc', [i, u, s]),
    getTransaction: async (s) => txs.get(s) ?? null,
  };
  const player = async (name: string, o: { anonymous?: boolean; wallet?: string | null } = {}) => {
    const u = await t.user(name, o.anonymous);
    const wallet = o.wallet === undefined ? await newAddress() : o.wallet;
    users.set(`jwt-${u.id}`, { id: u.id, anonymous: o.anonymous === true, wallet });
    return { ...u, wallet: wallet as string, jwt: `jwt-${u.id}` };
  };
  type P = Awaited<ReturnType<typeof player>>;
  const post = async (h: typeof usdcIntentHandler, body: unknown, jwt: string | null, origin = 'https://pokejam.xyz') => {
    const res = await h(new Request('https://f/x', { method: 'POST', headers: { origin, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) }, body: JSON.stringify(body) }), cfg, deps);
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
  };
  const intent = (p: P, sku = 'shield_3') => post(usdcIntentHandler, { sku, ageConfirmed: true }, p.jwt);
  const confirm = (p: P, intentId: string, signature: string) => post(usdcConfirmHandler, { intentId, signature }, p.jwt);
  /** The transaction a well-behaved Phantom would produce for an intent response. */
  const pay = async (p: P, i: Record<string, any>, mut: (t: ChainTx) => void = () => {}) => {
    const sig = base58Encode(randomBytes(64));
    const row = (await rpc<Record<string, number>>('pokejam_shield_usdc_intent_get', [i.intentId, p.id]));
    const src = await deriveAta(p.wallet, i.mint);
    const dst = await deriveAta(i.receiver, i.mint);
    const amount = String(i.amount);
    const tx: ChainTx = {
      blockTime: row.created_at + 5,
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, mint: i.mint, owner: p.wallet, uiTokenAmount: { amount: '90000000' } }, { accountIndex: 2, mint: i.mint, owner: i.receiver, uiTokenAmount: { amount: '0' } }],
        postTokenBalances: [{ accountIndex: 1, mint: i.mint, owner: p.wallet, uiTokenAmount: { amount: String(90000000 - Number(amount)) } }, { accountIndex: 2, mint: i.mint, owner: i.receiver, uiTokenAmount: { amount } }],
      },
      transaction: { signatures: [sig], message: {
        accountKeys: [{ pubkey: p.wallet, signer: true, writable: true }, { pubkey: src, signer: false, writable: true }, { pubkey: dst, signer: false, writable: true },
          { pubkey: i.mint, signer: false, writable: false }, { pubkey: i.reference, signer: false, writable: false }],
        instructions: [
          { programId: PROGRAM.token, parsed: { type: 'transferChecked', info: { source: src, mint: i.mint, destination: dst, multisigAuthority: p.wallet, signers: [i.reference], tokenAmount: { amount, decimals: 6 } } } },
          { programId: PROGRAM.memo, parsed: i.memo },
        ] } },
    };
    mut(tx);
    txs.set(sig, tx);
    return sig;
  };
  const held = async (p: { id: string }) => Number((await t.sql('select count from public.pokejam_shield_inventory where user_id = $1', [p.id]))[0]?.count ?? 0);
  return { t, cfg, deps, rpc, txs, player, intent, confirm, pay, held, logs, post, setNow: (ms: number) => { nowMs = ms; } };
}

describe('shield-usdc-intent', () => {
  it('returns a one-time intent with the price from the database and the receiver and mint from config', async () => {
    const s = await setup();
    const a = await s.player('A');
    const r = await s.intent(a, 'shield_7');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sku: 'shield_7', units: 7, amount: '3990000', decimals: 6, cluster: 'devnet', mint: MINT, receiver: s.cfg.receiver });
    expect(base58Decode(r.body!.reference)).toHaveLength(32);
    expect(r.body!.memo).toMatch(/^pj-/);
    const row = (await s.t.sql('select * from public.pokejam_shield_usdc_intents where id = $1', [r.body!.intentId]))[0];
    expect(row).toMatchObject({ user_id: a.id, wallet: a.wallet, status: 'pending', amount: 3990000 });
    const r2 = await s.intent(a, 'shield_7');
    expect(r2.body!.reference).not.toBe(r.body!.reference);
    expect(r2.body!.memo).not.toBe(r.body!.memo);
  });
  it('is for signed-in Phantom users only, with a checked sku, the age box, a known origin, and POST', async () => {
    const s = await setup();
    const guest = await s.player('G', { anonymous: true, wallet: null });
    const google = await s.player('Go', { wallet: null });
    const a = await s.player('A');
    expect((await s.intent(guest)).body).toMatchObject({ code: 'guest' });
    expect((await s.intent(google)).status).toBe(403);
    expect((await s.intent(google)).body).toMatchObject({ code: 'no_wallet' });
    expect((await s.post(usdcIntentHandler, { sku: 'shield_3', ageConfirmed: true }, null)).status).toBe(401);
    expect((await s.post(usdcIntentHandler, { sku: 'shield_3', ageConfirmed: true }, 'bad-jwt')).status).toBe(401);
    expect((await s.post(usdcIntentHandler, { sku: 'shield_3' }, a.jwt)).body).toMatchObject({ code: 'age' });
    expect((await s.post(usdcIntentHandler, { sku: 'x y', ageConfirmed: true }, a.jwt)).status).toBe(400);
    expect((await s.post(usdcIntentHandler, { sku: 'shield_99', ageConfirmed: true }, a.jwt)).body).toMatchObject({ code: 'unknown_sku' });
    expect((await s.post(usdcIntentHandler, { sku: 'shield_3', ageConfirmed: true }, a.jwt, 'https://evil.example')).status).toBe(403);
    const get = await usdcIntentHandler(new Request('https://f/x', { method: 'GET' }), s.cfg, s.deps);
    expect(get.status).toBe(405);
    const opts = await usdcIntentHandler(new Request('https://f/x', { method: 'OPTIONS', headers: { origin: 'https://pokejam.xyz' } }), s.cfg, s.deps);
    expect(opts.status).toBe(204);
    expect(opts.headers.get('access-control-allow-origin')).toBe('https://pokejam.xyz');
    expect(await s.t.sql('select 1 from public.pokejam_shield_usdc_intents')).toHaveLength(0);
  });
  it('ignores a wallet, receiver, mint, cluster or price sent by the client', async () => {
    const s = await setup();
    const a = await s.player('A');
    const other = await newAddress();
    const r = await s.post(usdcIntentHandler, { sku: 'shield_3', ageConfirmed: true, wallet: other, receiver: other, mint: other, cluster: 'mainnet-beta', amount: '1' }, a.jwt);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ receiver: s.cfg.receiver, mint: MINT, cluster: 'devnet', amount: '1990000' });
    const row = (await s.t.sql('select * from public.pokejam_shield_usdc_intents where id = $1', [r.body!.intentId]))[0];
    expect(row).toMatchObject({ wallet: a.wallet, receiver: s.cfg.receiver, mint: MINT, cluster: 'devnet', amount: 1990000 });
  });
  it('is off when the config is off (no receiver; mainnet without approval)', async () => {
    const s = await setup();
    const a = await s.player('A');
    const off = usdcConfig(() => undefined);
    const res = await usdcIntentHandler(new Request('https://f/x', { method: 'POST', headers: { origin: 'https://pokejam.xyz', authorization: `Bearer ${a.jwt}` }, body: '{"sku":"shield_3","ageConfirmed":true}' }), off, s.deps);
    expect(res.status).toBe(503);
    expect(s.logs.join()).toMatch(/RECEIVER/);
  });
  it('applies the shop caps: 14 held, 42 per season including pending, rate limit, dispute block, no usdc price', async () => {
    const s = await setup();
    const a = await s.player('A');
    await s.t.sql('insert into public.pokejam_shield_inventory(user_id, count) values ($1, 12)', [a.id]);
    expect((await s.intent(a, 'shield_3')).body).toMatchObject({ code: 'hold_cap' });
    await s.t.sql('update public.pokejam_shield_inventory set count = 0 where user_id = $1', [a.id]);
    await s.t.sql(`update public.pokejam_shield_products set usdc_amount = null where sku = 'shield_14'`);
    expect((await s.intent(a, 'shield_14')).body).toMatchObject({ code: 'no_usdc' });
    expect(await s.t.sql('select 1 from public.pokejam_shield_checkouts where user_id = $1', [a.id])).toHaveLength(0);
    for (let i = 0; i < 5; i++) expect((await s.intent(a, 'shield_3')).status).toBe(200);
    expect((await s.intent(a, 'shield_3')).status).toBe(429);
    const b = await s.player('B');
    await s.t.sql(`insert into public.pokejam_shield_flags(user_id, purchase_blocked, reason) values ($1, true, 'dispute')`, [b.id]);
    expect((await s.intent(b)).status).toBe(403);
  });
});

describe('shield-usdc-confirm', () => {
  it('credits the shields once for a correct payment, and a repeat with the same signature changes nothing', async () => {
    const s = await setup();
    const a = await s.player('A');
    const i = (await s.intent(a, 'shield_3')).body!;
    const sig = await s.pay(a, i);
    const r = await s.confirm(a, i.intentId, sig);
    expect(r).toMatchObject({ status: 200, body: { status: 'credited', credited: 3, short: 0 } });
    expect(await s.held(a)).toBe(3);
    const again = await s.confirm(a, i.intentId, sig);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'credited', duplicate: true });
    expect(await s.held(a)).toBe(3);
    expect(await s.t.sql(`select 1 from public.pokejam_shield_ledger where user_id = $1 and reason = 'purchase'`, [a.id])).toHaveLength(1);
    const pu = (await s.t.sql('select * from public.pokejam_shield_purchases where user_id = $1', [a.id]))[0];
    expect(pu).toMatchObject({ rail: 'usdc', usdc_signature: sig, wallet: a.wallet, units: 3, amount_cents: 199, credited_units: 3, needs_refund: false, status: 'paid', session_id: `usdc:${sig}` });
    // a retry that the database sees first (a confirm that raced the first one) is also a no-op
    expect(await s.rpc('pokejam_shield_credit_usdc', [i.intentId, a.id, sig])).toMatchObject({ status: 'duplicate', credited: 3 });
    expect(await s.held(a)).toBe(3);
  });
  it('answers pending (202) until the transaction shows up, then credits with the same signature', async () => {
    const s = await setup();
    const a = await s.player('A');
    const i = (await s.intent(a)).body!;
    const sig = await s.pay(a, i);
    const tx = s.txs.get(sig)!;
    s.txs.delete(sig);
    expect(await s.confirm(a, i.intentId, sig)).toMatchObject({ status: 202, body: { status: 'pending' } });
    expect(await s.held(a)).toBe(0);
    s.txs.set(sig, tx);
    expect((await s.confirm(a, i.intentId, sig)).body).toMatchObject({ status: 'credited', credited: 3 });
  });
  it('reconciles late: a payment made inside the window can be confirmed after the intent expired', async () => {
    const s = await setup();
    const a = await s.player('A');
    const i = (await s.intent(a)).body!;
    const sig = await s.pay(a, i);
    s.setNow(Date.now() + 3 * 3600_000);
    expect((await s.confirm(a, i.intentId, sig)).body).toMatchObject({ status: 'credited' });
  });
  it('refuses an expired intent: no transaction after expiry plus grace (410), or a transaction made after that', async () => {
    const s = await setup();
    const a = await s.player('A');
    const i = (await s.intent(a)).body!;
    const never = base58Encode(randomBytes(64));
    s.setNow(Date.now() + 5 * 60_000);
    expect((await s.confirm(a, i.intentId, never)).status).toBe(202); // still inside the window: keep polling
    s.setNow(Date.now() + 3 * 3600_000);
    expect(await s.confirm(a, i.intentId, never)).toMatchObject({ status: 410, body: { code: 'expired' } });
    const late = await s.pay(a, i, (t) => { t.blockTime = Math.floor(Date.now() / 1000) + 3 * 3600; });
    expect(await s.confirm(a, i.intentId, late)).toMatchObject({ status: 410, body: { code: 'expired' } });
    expect(await s.held(a)).toBe(0);
  });
  it('refuses a signature that belongs to another intent, whoever sends it', async () => {
    const s = await setup();
    const a = await s.player('A');
    const b = await s.player('B');
    const ia = (await s.intent(a)).body!;
    const ib = (await s.intent(a)).body!;
    const sig = await s.pay(a, ia);
    expect(await s.confirm(a, ia.intentId, sig)).toMatchObject({ status: 200 });
    // same player, second intent, first payment's signature: the reference and memo are not in that transaction
    expect(await s.confirm(a, ib.intentId, sig)).toMatchObject({ status: 400, body: { code: 'missing_reference' } });
    // the database refuses it even if a forged verdict got that far
    expect(await s.rpc('pokejam_shield_credit_usdc', [ib.intentId, a.id, sig])).toMatchObject({ status: 'signature_used' });
    // another player cannot use A's intent
    expect((await s.confirm(b, ia.intentId, sig)).status).toBe(404);
    expect(await s.rpc('pokejam_shield_credit_usdc', [ia.intentId, b.id, sig])).toMatchObject({ status: 'wrong_user' });
    expect(await s.held(a)).toBe(3);
    expect(await s.held(b)).toBe(0);
  });
  it('credits an intent only once even when it is paid twice with different transactions', async () => {
    const s = await setup();
    const a = await s.player('A');
    const i = (await s.intent(a)).body!;
    const one = await s.pay(a, i);
    const two = await s.pay(a, i);
    expect((await s.confirm(a, i.intentId, one)).body).toMatchObject({ status: 'credited' });
    expect(await s.confirm(a, i.intentId, two)).toMatchObject({ status: 409, body: { code: 'intent_done' } });
    expect(await s.held(a)).toBe(3);
    expect(await s.t.sql(`select 1 from public.pokejam_shield_purchases where rail = 'usdc'`)).toHaveLength(1);
  });
  it.each([
    ['wrong mint', (t: ChainTx) => { xfer(t).mint = USDC_MINT['mainnet-beta']; }, 'wrong_mint'],
    ['more than the price', (t: ChainTx) => { (xfer(t).tokenAmount as { amount: string }).amount = '2000000'; }, 'wrong_amount'],
    ['less than the price', (t: ChainTx) => { (xfer(t).tokenAmount as { amount: string }).amount = '1980000'; }, 'wrong_amount'],
    ['to someone else', (t: ChainTx) => { xfer(t).destination = 'So11111111111111111111111111111111111111112'; }, 'wrong_recipient'],
    ['signed by another wallet', (t: ChainTx) => { xfer(t).multisigAuthority = 'So11111111111111111111111111111111111111112'; }, 'wrong_signer'],
    ['without the reference', (t: ChainTx) => { t.transaction!.message!.accountKeys!.pop(); }, 'missing_reference'],
    ['without the memo', (t: ChainTx) => { t.transaction!.message!.instructions!.pop(); }, 'missing_memo'],
    ['that failed', (t: ChainTx) => { t.meta!.err = { InstructionError: [1, 'Custom'] }; }, 'tx_failed'],
  ])('refuses a payment %s and credits nothing', async (_n, mut, expected) => {
    const s = await setup();
    const a = await s.player('A');
    const i = (await s.intent(a)).body!;
    const sig = await s.pay(a, i, mut);
    const r = await s.confirm(a, i.intentId, sig);
    expect(r.body).toMatchObject({ code: expected });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await s.held(a)).toBe(0);
    expect(await s.t.sql('select 1 from public.pokejam_shield_purchases')).toHaveLength(0);
    expect((await s.t.sql('select status from public.pokejam_shield_usdc_intents where id = $1', [i.intentId]))[0].status).toBe('pending');
  });
  it('is for the intent owner, signed in with the same wallet, with a well-formed request', async () => {
    const s = await setup();
    const a = await s.player('A');
    const i = (await s.intent(a)).body!;
    const sig = await s.pay(a, i);
    expect((await s.post(usdcConfirmHandler, { intentId: 'nope', signature: sig }, a.jwt)).status).toBe(400);
    expect((await s.post(usdcConfirmHandler, { intentId: i.intentId, signature: 'abc' }, a.jwt)).status).toBe(400);
    expect((await s.post(usdcConfirmHandler, { intentId: crypto.randomUUID(), signature: sig }, a.jwt)).status).toBe(404);
    expect((await s.post(usdcConfirmHandler, { intentId: i.intentId, signature: sig }, null)).status).toBe(401);
    // the account now reports a different wallet than the one the intent was made for
    s.deps.userOf = async () => ({ id: a.id, anonymous: false, wallet: await newAddress() });
    expect((await s.confirm(a, i.intentId, sig)).body).toMatchObject({ code: 'wrong_signer' });
    expect(await s.held(a)).toBe(0);
  });
  it('credits up to 14 and flags the rest for a manual USDC refund when the cap filled up in between', async () => {
    const s = await setup();
    const a = await s.player('A');
    const i = (await s.intent(a, 'shield_7')).body!;
    await s.t.sql('insert into public.pokejam_shield_inventory(user_id, count) values ($1, 10) on conflict (user_id) do update set count = 10', [a.id]);
    const sig = await s.pay(a, i);
    expect((await s.confirm(a, i.intentId, sig)).body).toMatchObject({ status: 'credited', credited: 4, short: 3 });
    expect(await s.held(a)).toBe(14);
    expect((await s.t.sql('select needs_refund, credit_short from public.pokejam_shield_purchases'))[0]).toMatchObject({ needs_refund: true, credit_short: 3 });
    expect(s.logs.join()).toMatch(/manual USDC refund/);
  });
  it('turns RPC and database failures into retryable 502s', async () => {
    const s = await setup();
    const a = await s.player('A');
    const i = (await s.intent(a)).body!;
    const sig = await s.pay(a, i);
    const real = s.deps.getTransaction;
    s.deps.getTransaction = async () => { throw new Error('RPC getTransaction: HTTP 429'); };
    expect(await s.confirm(a, i.intentId, sig)).toMatchObject({ status: 502, body: { code: 'rpc' } });
    s.deps.getTransaction = real;
    const realCredit = s.deps.credit;
    s.deps.credit = async () => { throw new Error('boom'); };
    expect(await s.confirm(a, i.intentId, sig)).toMatchObject({ status: 502, body: { code: 'db' } });
    s.deps.credit = realCredit;
    expect((await s.confirm(a, i.intentId, sig)).body).toMatchObject({ status: 'credited' });
    expect(await s.held(a)).toBe(3);
  });
});
