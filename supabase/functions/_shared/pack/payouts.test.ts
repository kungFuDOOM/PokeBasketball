import { describe, expect, it, vi } from 'vitest';
import { CollectorCrypt } from './collector-crypt.ts';
import { MAINNET_APPROVAL, authorized, packConfig } from './config.ts';
import { generateKeypair } from './ed25519.ts';
import { blockedReason, machineRows, parseMachines, tierMachines } from './machines.ts';
import { MAX_ATTEMPTS, healthAlerts, runPayouts } from './payouts.ts';
import { Rpc } from './rpc.ts';
import { sqlStore } from './store.ts';
import { fakeChain, fakeCollectorCrypt, route, sql, testDb } from './test/helpers.ts';

// Each test starts its own in-process Postgres and fake chain: under 1s alone, but 8-10s when the whole suite runs in
// parallel on a busy machine, past vitest's 5s default. Test-only; the code under test has its own timeouts.
vi.setConfig({ testTimeout: 30_000 });

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

async function setup(opts: Parameters<typeof fakeCollectorCrypt>[2] & { houseUsdc?: boolean } = {}) {
  const house = (await generateKeypair()).keypair;
  const chain = fakeChain();
  const fake = await fakeCollectorCrypt(house.address, chain, opts);
  const fetch = route(fake, chain);
  const rpc = new Rpc(chain.url, fetch);
  const cc = new CollectorCrypt({ house, rpc, baseUrl: fake.url, fetch, openTimeoutMs: 2000, pollMs: 5, guard: fake.guard });
  const t = await testDb();
  const store = sqlStore(t.service);
  const winner = await t.user();
  const wallet = (await generateKeypair()).keypair.address;
  const deps = { store, cc, rpc: opts.houseUsdc ? rpc : null, houseUsdcAccount: opts.houseUsdc ? 'HouseUsdc' : '', fallbackAfter: 3, log: quiet,
    onMachines: async (m: ReturnType<typeof tierMachines>) => { await t.service('pokejam_pack_upsert_machines', { p_rows: machineRows(m) }); } };
  const queue = async (over: { battle?: string; tier?: string; price?: number; cash?: boolean } = {}) =>
    (await t.service('pokejam_pack_queue_prize', {
      p_battle: over.battle ?? 'b1', p_user: winner, p_wallet: wallet, p_tier: over.tier ?? 'pokemon_25',
      p_price: over.price ?? 25_000_000, p_prefer_cash: over.cash ?? false,
    }) as Record<string, string>[])[0].pokejam_pack_queue_prize;
  const prize = async (id: string) => (await sql(t.db, 'select * from public.pokejam_pack_prizes where id = $1', [id]))[0];
  const balance = async () => Number((await t.asPlayer(winner, 'select public.pokejam_pack_balance() as b'))[0].b);
  const generates = () => fake.calls.filter((c) => c.path === '/api/generatePack').length;
  const retryNow = () => sql(t.db, 'update public.pokejam_pack_prizes set next_try_at = now()');
  return { house, chain, fake, cc, t, store, deps, winner, wallet, queue, prize, balance, generates, retryNow };
}

describe('Pack Battles payouts', () => {
  it("buys the winner's pull after the result, keeps the pull and its VRF output, and sends the card exactly once", async () => {
    const s = await setup();
    const id = await s.queue();
    expect(await s.queue()).toBe(id); // queuing the same battle twice is one prize
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'sent' }]);
    const p = await s.prize(id);
    expect(p.state).toBe('sent');
    expect(s.chain.assets.get(String(p.nft_address))!.owner).toBe(s.wallet);
    const pull = p.pull as { name: string; entropy: string; memo: string; verifyUrl: string };
    expect(pull.name).toBe('2023 #285 Garganacl PSA 10');
    expect(pull.entropy).toBe(s.fake.memos.get(pull.memo)!.beta); // read from CC's 0x-prefixed beta
    expect(pull.verifyUrl).toContain(`/verify-selection/${pull.memo}`);
    expect(await runPayouts(s.deps)).toEqual([]);
    expect(s.chain.transfers).toHaveLength(1);
    expect(s.generates()).toBe(1);
    expect(await s.balance()).toBe(0);
  });

  it('a winner who prefers cash gets the buyback credited, and the card goes back to Collector Crypt', async () => {
    const s = await setup();
    const id = await s.queue({ cash: true });
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'cashed' }]);
    const p = await s.prize(id);
    expect(p.state).toBe('cashed');
    expect(Number(p.cash_amount)).toBe(45_900_000);
    expect(await s.balance()).toBe(45_900_000);
    expect(s.chain.assets.get(String(p.nft_address))!.owner).toBe(s.fake.gacha);
    expect(await runPayouts(s.deps)).toEqual([]);
    expect(await s.balance()).toBe(45_900_000);
  });

  it('never buys a pull priced above the pot; after three refusals the winner is credited the whole pot', async () => {
    const s = await setup();
    s.fake.machines.get('pokemon_25')!.price = 30;
    const id = await s.queue();
    for (let i = 0; i < 2; i++) {
      expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]);
      await s.retryNow();
    }
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'refunded' }]);
    expect(await s.prize(id)).toMatchObject({ state: 'refunded' });
    expect(await s.balance()).toBe(25_000_000);
    expect(s.generates()).toBe(0);
    // The lobby's copy of the machines was refreshed along the way, and shows the tier as paused.
    const m = (await sql(s.t.db, "select * from public.pokejam_pack_machines where code = 'pokemon_25'"))[0];
    expect(m.available).toBe(false);
    expect(String(m.why)).toMatch(/\$30/);
  });

  it('a machine that got cheaper is still bought (the house keeps the difference)', async () => {
    const s = await setup();
    s.fake.machines.get('pokemon_50')!.price = 45;
    const id = await s.queue({ tier: 'pokemon_50', price: 50_000_000, battle: 'b2' });
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'sent' }]);
  });

  it('a machine out of a prize tier is refused before paying', async () => {
    const s = await setup();
    s.fake.machines.get('pokemon_25')!.stock.epic = 0;
    const id = await s.queue();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]);
    expect(String((await s.prize(id)).last_error)).toMatch(/out of epic cards/);
    expect(s.generates()).toBe(0);
  });

  it('a house short of USDC keeps retrying instead of refunding, and buys nothing until it can', async () => {
    const s = await setup({ houseUsdc: true });
    s.chain.setBalance(1_000_000);
    const id = await s.queue();
    for (let i = 0; i < 4; i++) {
      expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]);
      await s.retryNow();
    }
    expect(s.generates()).toBe(0);
    expect((await s.prize(id)).attempts).toBe(0); // waiting on money uses up none of its tries
    s.chain.setBalance(1e12);
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'sent' }]);
  });

  it('a refusal before payment retries; a failure after payment resumes the memo and never buys twice', async () => {
    const s = await setup({ failGenerate: 1, failOpenAfterPay: 1 });
    const id = await s.queue();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]); // CC refused to sell
    await s.retryNow();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]); // paid, then openPack failed
    expect((await s.prize(id)).memo).toBeTruthy();
    await s.retryNow();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'sent' }]); // resumed from the memo
    expect(s.generates()).toBe(2); // the refused call and one real purchase
    expect([...s.fake.memos.values()].filter((m) => m.paid)).toHaveLength(1);
  });

  it('after a crash, a prize with a card goes back in the queue and is checked on-chain, not sent twice', async () => {
    const s = await setup();
    const id = await s.queue();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'sent' }]);
    // Pretend the run crashed right after the transfer landed, 15 minutes ago.
    await sql(s.t.db, "update public.pokejam_pack_prizes set state = 'sending', updated_at = now() - interval '15 minutes'");
    await s.store.recover(MAX_ATTEMPTS);
    expect((await s.prize(id)).state).toBe('pending');
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'sent' }]);
    expect(s.chain.transfers).toHaveLength(1);
  });

  it('a crash before anything was submitted goes back in the queue (nothing could be charged); a run in progress is left alone', async () => {
    const s = await setup();
    const a = await s.queue({ battle: 'old' });
    const b = await s.queue({ battle: 'new' });
    await sql(s.t.db, "update public.pokejam_pack_prizes set state = 'sending', updated_at = now() - interval '15 minutes' where id = $1", [a]);
    await sql(s.t.db, "update public.pokejam_pack_prizes set state = 'sending' where id = $1", [b]);
    await s.store.recover(MAX_ATTEMPTS);
    expect(await s.prize(a)).toMatchObject({ state: 'pending', attempts: 0 });
    expect((await s.prize(b)).state).toBe('sending');
    expect(await runPayouts(s.deps)).toEqual([{ id: a, outcome: 'sent' }]);
    expect(s.generates()).toBe(1);
  });

  it('a card that is not a Metaplex Core asset fails loudly instead of being misread, and is never refunded', async () => {
    const s = await setup({ card: 'pnft' });
    const id = await s.queue();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]);
    const p = await s.prize(id);
    expect(String(p.last_error)).toMatch(/not a Metaplex Core asset/);
    expect(p.nft_address).toBeTruthy(); // bought and kept: a person sends it by hand
    expect(s.chain.transfers).toHaveLength(0);
    expect(await s.balance()).toBe(0);
  });
});

describe('keep it or sell it back, at the reveal', () => {
  const reveal = async (over: Parameters<Awaited<ReturnType<typeof setup>>['queue']>[0] = {}) => {
    const s = await setup();
    const deps = { ...s.deps, choiceSeconds: 120 };
    const id = await s.queue(over);
    expect(await runPayouts(deps)).toEqual([{ id, outcome: 'revealed' }]);
    const choose = (choice: string, who = s.winner) =>
      s.t.callAs('authenticated', who)('pokejam_pack_choose_prize', { p_id: id, p_choice: choice })
        .then((r) => (r as Record<string, boolean>[])[0].pokejam_pack_choose_prize);
    const owner = async () => s.chain.assets.get(String((await s.prize(id)).nft_address))!.owner;
    const timeUp = () => sql(s.t.db, "update public.pokejam_pack_prizes set choose_by = now() - interval '1 second' where id = $1", [id]);
    return { ...s, deps, id, choose, owner, timeUp };
  };

  it('opens the pull, then holds the card in the house wallet while the winner decides', async () => {
    const s = await reveal();
    const p = await s.prize(s.id);
    expect(p.state).toBe('revealed');
    expect(Number(p.sell_estimate)).toBe(45_900_000); // $54 insured at the machine's 85% buyback
    const wait = (new Date(String(p.choose_by)).getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(110);
    expect(wait).toBeLessThanOrEqual(121);
    expect(await s.owner()).not.toBe(s.wallet);
    expect(await runPayouts(s.deps)).toEqual([]); // nothing to do until a pick or the deadline
    expect(s.chain.transfers).toHaveLength(0);
    expect(s.generates()).toBe(1);
    // The winner sees it through RLS like any other prize row.
    expect(await s.t.asPlayer(s.winner, 'select state, sell_estimate from public.pokejam_pack_prizes'))
      .toEqual([{ state: 'revealed', sell_estimate: 45_900_000 }]);
  });

  it('Sell it back: CC buys the card back and the buyback is credited', async () => {
    const s = await reveal();
    expect(await s.choose('sell')).toBe(true);
    expect(await runPayouts(s.deps)).toEqual([{ id: s.id, outcome: 'cashed' }]);
    expect(await s.balance()).toBe(45_900_000);
    expect(await s.owner()).toBe(s.fake.gacha);
    expect(await s.prize(s.id)).toMatchObject({ state: 'cashed', choice: 'sell' });
  });

  it('Keep it wins over a saved preference for cash', async () => {
    const s = await reveal({ cash: true });
    expect(await s.choose('sell')).toBe(true);
    expect(await s.choose('keep')).toBe(true); // a change of mind before the worker gets to it counts
    expect(await runPayouts(s.deps)).toEqual([{ id: s.id, outcome: 'sent' }]);
    expect(await s.owner()).toBe(s.wallet);
    expect(await s.balance()).toBe(0);
  });

  it('no pick: the saved preference applies once the time is up', async () => {
    const cash = await reveal({ cash: true });
    await cash.timeUp();
    expect(await runPayouts(cash.deps)).toEqual([{ id: cash.id, outcome: 'cashed' }]);
    expect(await cash.balance()).toBe(45_900_000);
    const card = await reveal();
    await card.timeUp();
    expect(await runPayouts(card.deps)).toEqual([{ id: card.id, outcome: 'sent' }]);
    expect(await card.owner()).toBe(card.wallet);
  });

  it('only the winner can choose, only keep or sell, and only while the card is waiting', async () => {
    const s = await reveal();
    const other = await s.t.user();
    expect(await s.choose('sell', other)).toBe(false);
    expect((await s.prize(s.id)).choice).toBeNull();
    await expect(s.choose('both')).rejects.toThrow(/keep or sell/);
    await expect(s.t.callAs('anon')('pokejam_pack_choose_prize', { p_id: s.id, p_choice: 'sell' })).rejects.toThrow(/permission denied/);
    await expect(s.t.callAs('authenticated', s.winner)('pokejam_pack_prize_revealed', { p_id: s.id, p_wait_seconds: 9999, p_sell_estimate: 1 }))
      .rejects.toThrow(/permission denied/);
    await expect(s.t.asPlayer(s.winner, "update public.pokejam_pack_prizes set choice = 'sell'")).rejects.toThrow(/permission denied/);
    expect(await s.choose('keep')).toBe(true);
    expect(await runPayouts(s.deps)).toEqual([{ id: s.id, outcome: 'sent' }]);
    expect(await s.choose('sell')).toBe(false); // already on its way
    expect((await s.prize(s.id)).state).toBe('sent');
    // A prize that hasn't been opened yet can't be chosen either.
    const fresh = await s.queue({ battle: 'b9' });
    expect((await s.t.callAs('authenticated', s.winner)('pokejam_pack_choose_prize', { p_id: fresh, p_choice: 'sell' }) as Record<string, boolean>[])[0]
      .pokejam_pack_choose_prize).toBe(false);
  });

  it('a restart leaves a waiting card waiting, and a crash mid-payout keeps the original deadline', async () => {
    const s = await reveal();
    const before = String((await s.prize(s.id)).choose_by);
    await sql(s.t.db, "update public.pokejam_pack_prizes set updated_at = now() - interval '15 minutes'");
    await s.store.recover(MAX_ATTEMPTS);
    expect((await s.prize(s.id)).state).toBe('revealed');
    // Claimed after a pick, then the run died before paying: recovery requeues it, and it settles by the pick.
    expect(await s.choose('sell')).toBe(true);
    await sql(s.t.db, "update public.pokejam_pack_prizes set state = 'sending', updated_at = now() - interval '15 minutes'");
    await s.store.recover(MAX_ATTEMPTS);
    expect(await runPayouts(s.deps)).toEqual([{ id: s.id, outcome: 'cashed' }]);
    expect(String((await s.prize(s.id)).choose_by)).toBe(before);
    expect(s.generates()).toBe(1);
  });

  it('with no wait configured, the saved preference applies straight away', async () => {
    const s = await setup();
    const id = await s.queue({ cash: true });
    expect(await runPayouts({ ...s.deps, choiceSeconds: 0 })).toEqual([{ id, outcome: 'cashed' }]);
    expect((await s.prize(id)).choose_by).toBeNull();
  });
});

describe('payouts database', () => {
  it('players read only their own prizes and ledger, and cannot call the service functions', async () => {
    const s = await setup({ card: 'core' });
    await s.queue({ cash: true });
    await runPayouts(s.deps);
    const other = await s.t.user();
    expect(await s.t.asPlayer(s.winner, 'select state from public.pokejam_pack_prizes')).toEqual([{ state: 'cashed' }]);
    expect(await s.t.asPlayer(other, 'select state from public.pokejam_pack_prizes')).toEqual([]);
    expect(await s.t.asPlayer(other, 'select * from public.pokejam_pack_ledger')).toEqual([]);
    expect(Number((await s.t.asPlayer(other, 'select public.pokejam_pack_balance() as b'))[0].b)).toBe(0);
    await expect(s.t.callAs('authenticated', other)('pokejam_pack_queue_prize', { p_battle: 'x', p_user: other, p_wallet: s.wallet, p_tier: 'pokemon_25', p_price: 1, p_prefer_cash: false })).rejects.toThrow(/permission denied/);
    await expect(s.t.callAs('authenticated', other)('pokejam_pack_claim_prizes', { p_limit: 10, p_max_attempts: 8 })).rejects.toThrow(/permission denied/);
    await expect(s.t.asPlayer(other, "insert into public.pokejam_pack_ledger(user_id, delta, kind, ref) values ($1, 999, 'adjust', 'x')", [other])).rejects.toThrow(/permission denied/);
    await expect(s.t.callAs('anon')('pokejam_pack_balance', {})).rejects.toThrow(/permission denied/);
  });

  it('a credit is idempotent, and a paid prize can never also be refunded', async () => {
    const s = await setup();
    const id = await s.queue();
    await sql(s.t.db, "update public.pokejam_pack_prizes set state = 'sending', memo = 'cc-9' where id = $1", [id]);
    await expect(s.t.service('pokejam_pack_prize_refunded', { p_id: id, p_why: 'x' })).rejects.toThrow(/already paid for/);
    await sql(s.t.db, "update public.pokejam_pack_prizes set memo = null where id = $1", [id]);
    await s.t.service('pokejam_pack_prize_refunded', { p_id: id, p_why: 'machine off' });
    await s.t.service('pokejam_pack_prize_refunded', { p_id: id, p_why: 'machine off' });
    expect(await s.balance()).toBe(25_000_000);
  });
});

describe('machines and config', () => {
  it('parses CC machines and pauses a tier that is missing, empty or repriced', () => {
    const odds = { common: 0.75, epic: 0.25 };
    const m = parseMachines({ machines: [
      { code: 'pokemon_25', price: 25, public: true, instantBuyback: 85, ev: 27.57, odds, stock: { common: 3, epic: 1 } },
      { code: 'pokemon_50', price: 55, public: true, odds, stock: { common: 3, epic: 1 } },
      { code: 'pokemon_100', price: 100, public: true, odds, stock: { common: 3, epic: 0 } },
    ] });
    expect(blockedReason('pokemon_25', m.get('pokemon_25'))).toBeNull();
    expect(m.get('pokemon_25')).toMatchObject({ price: 25_000_000, buyback: 0.85, ev: 27.57 });
    expect(blockedReason('pokemon_50', m.get('pokemon_50'))).toMatch(/\$55/);
    expect(blockedReason('pokemon_100', m.get('pokemon_100'))).toMatch(/out of epic/);
    expect(blockedReason('pokemon_25', undefined)).toMatch(/isn't available/);
    // Shown to players, so the reasons name our tier, never the supplier.
    for (const tier of ['pokemon_25', 'pokemon_50', 'pokemon_100'] as const) expect(blockedReason(tier, m.get(tier)) ?? '').not.toMatch(/Collector Crypt/);
    const rows = machineRows(tierMachines(m));
    expect(rows.map((r) => r.available)).toEqual([true, false, false]);
    expect(rows.map((r) => [r.machine_code, r.partner_fee_micro])).toEqual([['pokemon_25', 0], ['pokemon_50', 0], ['pokemon_100', 0]]);
  });

  it('buys from our own builder-fee machine when the key owns one, and records its fee', () => {
    const odds = { common: 0.75, epic: 0.25 };
    const house = parseMachines({ machines: [
      { code: 'pokemon_25', price: 25, public: true, odds, stock: { common: 3, epic: 1 } },
      { code: 'pokemon_50', price: 50, public: true, odds, stock: { common: 3, epic: 1 } },
      { code: 'pokemon_100', price: 100, public: true, odds, stock: { common: 3, epic: 1 } },
    ] });
    // GET /api/v1/machines: our adopted copies (new codes, scoped to our key), one of them switched off.
    const partner = parseMachines({ machines: [
      { code: 'bf_poke25_pj1', name: 'Pokémon $25', price: 25, enabled: true, partnerFee: 1.25, odds, stock: { common: 3, epic: 1 } },
      { code: 'bf_poke50_pj1', name: 'Pokémon $50', price: 50, enabled: false, partnerFee: 2.5, odds, stock: { common: 3, epic: 1 } },
      { code: 'bf_sports100_pj1', name: 'Mixed Sports $100', price: 100, enabled: true, partnerFee: 5, odds, stock: { common: 3, epic: 1 } },
    ] });
    const tiers = tierMachines(house, partner);
    expect(tiers.get('pokemon_25')).toMatchObject({ code: 'bf_poke25_pj1', partnerFee: 1_250_000, available: true });
    // Our $50 machine is off: the tier pauses (it never silently falls back to a machine that earns nothing).
    expect(tiers.get('pokemon_50')).toMatchObject({ code: 'bf_poke50_pj1', available: false, why: 'switched off' });
    // A sports machine at $100 isn't a Pokémon pack: the tier keeps CC's own machine.
    expect(tiers.get('pokemon_100')).toMatchObject({ code: 'pokemon_100', partnerFee: 0 });
    const rows = machineRows(tiers);
    expect(rows.map((r) => [r.code, r.machine_code, r.partner_fee_micro, r.available])).toEqual([
      ['pokemon_25', 'bf_poke25_pj1', 1_250_000, true], ['pokemon_50', 'bf_poke50_pj1', 2_500_000, false], ['pokemon_100', 'pokemon_100', 0, true]]);
    // CC_MACHINE_CODES names the machine outright.
    expect(tierMachines(house, partner, { pokemon_100: 'bf_sports100_pj1' }).get('pokemon_100')?.code).toBe('bf_sports100_pj1');
    // No key, or nothing adopted yet: CC's own machines, as before.
    expect([...tierMachines(house).values()].map((m) => m?.code)).toEqual(['pokemon_25', 'pokemon_50', 'pokemon_100']);
  });

  it('runs on devnet only until kungFuDOOM approves mainnet, and only for the service key', () => {
    const env = (e: Record<string, string>) => (k: string) => e[k];
    const base = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', HOUSE_SECRET_KEY: '[1]' };
    expect(packConfig(env(base)).ccBaseUrl).toBe('https://dev-gacha.collectorcrypt.com');
    expect(packConfig(env(base)).choiceSeconds).toBe(120);
    expect(packConfig(env({ ...base, PRIZE_CHOICE_SECONDS: '0' })).choiceSeconds).toBe(0);
    expect(packConfig(env({ ...base, PRIZE_CHOICE_SECONDS: '-5' })).choiceSeconds).toBe(120);
    expect(() => packConfig(env({ ...base, CLUSTER: 'mainnet-beta' }))).toThrow(/devnet-only/);
    const mainnet = { ...base, CLUSTER: 'mainnet-beta', PACK_ALLOW_MAINNET: MAINNET_APPROVAL };
    // With real money, the house must be able to check where every payment goes.
    expect(() => packConfig(env(mainnet))).toThrow(/HOUSE_USDC_ACCOUNT and CC_SIGNER/);
    // Collector Crypt's mainnet gacha wallet is pinned (the owner of the gacha USDC account their docs publish).
    expect(packConfig(env({ ...mainnet, HOUSE_USDC_ACCOUNT: 'acct', RPC_URL: 'https://paid' })).ccSigner).toBe('GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3');
    expect(() => packConfig(env({ ...mainnet, HOUSE_USDC_ACCOUNT: 'acct', CC_MACHINE_CODES: 'nope' , RPC_URL: 'https://paid' }))).toThrow(/CC_MACHINE_CODES/);
    expect(packConfig(env({ ...mainnet, HOUSE_USDC_ACCOUNT: 'acct', RPC_URL: 'https://paid', CC_MACHINE_CODES: '{"pokemon_25":"bf_poke25_pj1"}' })).ccMachineCodes).toEqual({ pokemon_25: 'bf_poke25_pj1' });
    // And a paid RPC: the public endpoint rate-limits the deposit scan's history lookups.
    const checkable = { ...mainnet, HOUSE_USDC_ACCOUNT: 'acct', CC_SIGNER: 'cc' };
    expect(() => packConfig(env(checkable))).toThrow(/paid RPC/);
    expect(() => packConfig(env({ ...checkable, RPC_URL: 'https://api.mainnet-beta.solana.com' }))).toThrow(/paid RPC/);
    const live = packConfig(env({ ...checkable, RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=k' }));
    expect(live.ccBaseUrl).toBe('https://gacha.collectorcrypt.com');
    expect(live.priorityMicroLamports).toBe(20_000);
    expect(packConfig(env(base)).priorityMicroLamports).toBe(0);
    expect(() => packConfig(env({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 's' }))).toThrow(/HOUSE_SECRET_KEY/);
    const cfg = packConfig(env(base));
    expect(authorized(new Request('https://f', { headers: { authorization: 'Bearer svc' } }), cfg)).toBe(true);
    expect(authorized(new Request('https://f', { headers: { authorization: 'Bearer nope' } }), cfg)).toBe(false);
    expect(authorized(new Request('https://f'), cfg)).toBe(false);
  });
});

describe("the house only signs Collector Crypt transactions shaped like CC's real ones", () => {
  const submits = (s: Awaited<ReturnType<typeof setup>>) => s.fake.calls.filter((c) => c.path === '/api/submitTransaction').length;
  for (const evil of ['overcharge', 'drain-sol', 'fee-spike', 'set-authority', 'unknown-program', 'redirect', 'lookup-table'] as const) {
    it(`a purchase that tries ${evil} is never signed, and the prize is parked for a person`, async () => {
      const s = await setup();
      s.fake.state.evil = evil;
      const id = await s.queue();
      expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]);
      const p = await s.prize(id);
      expect(p.state).toBe('failed');
      expect(String(p.last_error)).toMatch(/Refusing to sign.*nothing was signed/);
      expect(p.attempts).toBe(MAX_ATTEMPTS);
      expect(submits(s)).toBe(0);
      await s.retryNow();
      expect(await runPayouts(s.deps)).toEqual([]); // not retried or refunded automatically: a person decides
      expect(await s.balance()).toBe(0);
    });
  }
  for (const evil of ['buyback-steal', 'buyback-short', 'buyback-other-card', 'buyback-house-pays'] as const) {
    it(`a buyback that tries ${evil} is never signed; the winner gets the card instead`, async () => {
      const s = await setup();
      s.fake.state.evil = evil;
      const id = await s.queue({ cash: true });
      expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'sent' }]);
      expect(s.chain.assets.get(String((await s.prize(id)).nft_address))!.owner).toBe(s.wallet);
      expect(await s.balance()).toBe(0);
      expect(submits(s)).toBe(1); // only the purchase
    });
  }
});

describe('fail-safe: a lost reply, a crash or a stuck chain never pays twice or loses a prize', () => {
  const paidMemos = (s: Awaited<ReturnType<typeof setup>>) => [...s.fake.memos.values()].filter((m) => m.paid).length;
  const buybacks = (s: Awaited<ReturnType<typeof setup>>) => s.fake.calls.filter((c) => c.path === '/api/buyback').length;

  it("a purchase whose reply was lost, but which landed, is resumed from the chain and never bought again", async () => {
    const s = await setup({ losePurchase: 1 });
    const id = await s.queue();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]);
    const p = await s.prize(id);
    expect(p.memo).toBeNull();
    expect(p.pay_txid).toBeTruthy(); // recorded before it was submitted
    expect(Number(p.pay_amount)).toBe(25_000_000);
    // The run then crashed: recovery requeues it, and the next run reads the chain before buying anything.
    await sql(s.t.db, "update public.pokejam_pack_prizes set state = 'sending', updated_at = now() - interval '15 minutes'");
    await s.store.recover(MAX_ATTEMPTS);
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'sent' }]);
    expect(s.generates()).toBe(1);
    expect(paidMemos(s)).toBe(1);
    expect((await s.prize(id)).memo).toBe(p.pay_memo);
  });

  it('a purchase that never landed waits while it still could, then is bought again once its blockhash has expired', async () => {
    const s = await setup({ dropPurchase: 1 });
    const id = await s.queue();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]);
    // Its blockhash is still valid, so it may yet land: hold, use up no attempt, buy nothing.
    s.chain.chainState.blockhashValid = true;
    await s.retryNow();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]);
    expect(await s.prize(id)).toMatchObject({ attempts: 1, last_error: expect.stringMatching(/still landing/) });
    expect(s.generates()).toBe(1);
    // Expired unseen: it can never land, so a fresh purchase is safe.
    s.chain.chainState.blockhashValid = false;
    await s.retryNow();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'sent' }]);
    expect(s.generates()).toBe(2);
    expect(paidMemos(s)).toBe(1);
  });

  it('a purchase that failed on-chain charged nothing and is bought again', async () => {
    const s = await setup({ dropPurchase: 1 });
    const id = await s.queue();
    await runPayouts(s.deps);
    s.chain.failedTx.add(String((await s.prize(id)).pay_txid));
    await s.retryNow();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'sent' }]);
    expect(paidMemos(s)).toBe(1);
  });

  it('a purchase that may be in flight can never be refunded as well', async () => {
    const s = await setup({ dropPurchase: 1 });
    const id = await s.queue();
    await runPayouts(s.deps);
    await sql(s.t.db, "update public.pokejam_pack_prizes set state = 'sending' where id = $1", [id]);
    await expect(s.t.service('pokejam_pack_prize_refunded', { p_id: id, p_why: 'x' })).rejects.toThrow(/already paid for/);
    expect(await s.balance()).toBe(0);
  });

  it('a buyback whose reply was lost, but which landed, is credited once, and the card is not also sent', async () => {
    const s = await setup({ loseBuyback: 1 });
    const id = await s.queue({ cash: true });
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]);
    expect(await s.balance()).toBe(0);
    expect(Number((await s.prize(id)).cash_pending)).toBe(45_900_000);
    await s.retryNow();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'cashed' }]);
    expect(await s.balance()).toBe(45_900_000);
    expect(s.chain.transfers).toHaveLength(0);
    expect(buybacks(s)).toBe(1);
    await s.retryNow();
    expect(await runPayouts(s.deps)).toEqual([]);
    expect(await s.balance()).toBe(45_900_000);
  });

  it('a buyback that never landed is tried again (after waiting while it still could), and credited once', async () => {
    const s = await setup({ dropBuyback: 1 });
    const id = await s.queue({ cash: true });
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]);
    s.chain.processing.add(String((await s.prize(id)).cash_txid));
    await s.retryNow();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'failed' }]); // in a block, not confirmed: wait
    expect(buybacks(s)).toBe(1);
    s.chain.processing.clear();
    await s.retryNow();
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'cashed' }]);
    expect(buybacks(s)).toBe(2);
    expect(await s.balance()).toBe(45_900_000);
    expect(s.chain.assets.get(String((await s.prize(id)).nft_address))!.owner).toBe(s.fake.gacha);
  });

  it('a card that is neither the house\'s nor the winner\'s is parked for a person, and nothing is credited', async () => {
    const s = await setup();
    const deps = { ...s.deps, choiceSeconds: 120 };
    const id = await s.queue({ cash: true });
    expect(await runPayouts(deps)).toEqual([{ id, outcome: 'revealed' }]);
    s.chain.assets.get(String((await s.prize(id)).nft_address))!.owner = (await generateKeypair()).keypair.address;
    await sql(s.t.db, "update public.pokejam_pack_prizes set choose_by = now() - interval '1 second'");
    expect(await runPayouts(deps)).toEqual([{ id, outcome: 'failed' }]);
    expect(await s.prize(id)).toMatchObject({ attempts: MAX_ATTEMPTS, last_error: expect.stringMatching(/needs a person/) });
    expect(buybacks(s)).toBe(0);
    expect(await s.balance()).toBe(0);
  });

  it('the kill switch stops every purchase, delivery and buyback until it is turned off', async () => {
    const s = await setup();
    const id = await s.queue();
    await sql(s.t.db, "update public.pokejam_config set value = 'true' where key = 'pack_payouts_paused'");
    expect(await runPayouts(s.deps)).toEqual([]);
    expect((await s.prize(id)).state).toBe('pending');
    expect(s.generates()).toBe(0);
    expect((await healthAlerts(s.store, null)).alerts.map((a) => a.key)).toContain('paused');
    await sql(s.t.db, "update public.pokejam_config set value = 'false' where key = 'pack_payouts_paused'");
    expect(await runPayouts(s.deps)).toEqual([{ id, outcome: 'sent' }]);
  });

  it('the hourly spending cap holds purchases over it without using up their attempts', async () => {
    const s = await setup();
    await sql(s.t.db, "update public.pokejam_config set value = '30000000' where key = 'pack_max_spend_per_hour'");
    const a = await s.queue({ battle: 'a' });
    const b = await s.queue({ battle: 'b' });
    expect(await runPayouts(s.deps)).toEqual([{ id: a, outcome: 'sent' }, { id: b, outcome: 'failed' }]);
    expect(await s.prize(b)).toMatchObject({ attempts: 0, last_error: expect.stringMatching(/hourly spending cap/) });
    expect(s.generates()).toBe(1);
    await sql(s.t.db, "update public.pokejam_config set value = '100000000' where key = 'pack_max_spend_per_hour'");
    await s.retryNow();
    expect(await runPayouts(s.deps)).toEqual([{ id: b, outcome: 'sent' }]);
  });
});

describe('the ledger', () => {
  const post = (t: Awaited<ReturnType<typeof testDb>>, user: string, delta: number, ref: string, kind = 'test') =>
    t.service('pokejam_pack_post', { p_user: user, p_delta: delta, p_kind: kind, p_ref: ref, p_note: null })
      .then((r) => (r as Record<string, boolean>[])[0].pokejam_pack_post);

  it('is append-only, even for the service role', async () => {
    const t = await testDb();
    const u = await t.user();
    await post(t, u, 10_000_000, 'r1');
    await expect(t.db.query('update public.pokejam_pack_ledger set delta = 99')).rejects.toThrow(/append-only/);
    await expect(t.db.query('delete from public.pokejam_pack_ledger')).rejects.toThrow(/append-only/);
  });

  it('never goes below zero; a post is idempotent, and a conflicting repeat is an error', async () => {
    const t = await testDb();
    const u = await t.user();
    const bal = async () => Number((await t.asPlayer(u, 'select public.pokejam_pack_balance() as b'))[0].b);
    expect(await post(t, u, 10_000_000, 'deposit-1', 'deposit')).toBe(true);
    expect(await post(t, u, 10_000_000, 'deposit-1', 'deposit')).toBe(false); // the same row again: no change
    await expect(post(t, u, 20_000_000, 'deposit-1', 'deposit')).rejects.toThrow(/different user or amount/);
    await expect(post(t, u, -15_000_000, 'entry-1', 'entry')).rejects.toThrow(/insufficient balance/);
    expect(await post(t, u, -10_000_000, 'entry-1', 'entry')).toBe(true);
    expect(await bal()).toBe(0);
    await expect(post(t, u, 0, 'zero')).rejects.toThrow(/not be zero/);
    await expect(t.callAs('authenticated', u)('pokejam_pack_post', { p_user: u, p_delta: 5, p_kind: 'x', p_ref: 'y', p_note: null })).rejects.toThrow(/permission denied/);
  });

  it('health counts what the house owes, and flags a wallet that holds less', async () => {
    const s = await setup();
    await s.queue(); // a $25 pot not bought yet
    await post(s.t, s.winner, 10_000_000, 'd1', 'deposit');
    const ok = await healthAlerts(s.store, 40_000_000);
    expect(ok.owed).toBe(35_000_000);
    expect(ok.alerts).toEqual([]);
    const short = await healthAlerts(s.store, 30_000_000);
    expect(short.alerts.map((a) => a.key)).toEqual(['insolvent']);
    expect(short.alerts[0].text).toMatch(/holds \$30 but owes players \$35/);
    // Once the pull is bought the pot is the card's, not a debt.
    await runPayouts(s.deps);
    expect((await healthAlerts(s.store, 10_000_000)).owed).toBe(10_000_000);
    // An alert goes out at most once an hour.
    expect(await s.store.alertDue('insolvent', 60)).toBe(true);
    expect(await s.store.alertDue('insolvent', 60)).toBe(false);
  });
});
