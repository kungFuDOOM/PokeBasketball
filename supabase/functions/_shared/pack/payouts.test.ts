import { describe, expect, it, vi } from 'vitest';
import { CollectorCrypt } from './collector-crypt.ts';
import { MAINNET_APPROVAL, authorized, packConfig } from './config.ts';
import { generateKeypair } from './ed25519.ts';
import { blockedReason, machineRows, parseMachines } from './machines.ts';
import { MAX_ATTEMPTS, runPayouts } from './payouts.ts';
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
    onMachines: async (m: ReturnType<typeof parseMachines>) => { await t.service('pokejam_pack_upsert_machines', { p_rows: machineRows(m) }); } };
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

  it('a crash before the memo was saved parks the prize for a person; a fresh run in progress is left alone', async () => {
    const s = await setup();
    const a = await s.queue({ battle: 'old' });
    const b = await s.queue({ battle: 'new' });
    await sql(s.t.db, "update public.pokejam_pack_prizes set state = 'sending', updated_at = now() - interval '15 minutes' where id = $1", [a]);
    await sql(s.t.db, "update public.pokejam_pack_prizes set state = 'sending' where id = $1", [b]);
    await s.store.recover(MAX_ATTEMPTS);
    expect(await s.prize(a)).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS });
    expect((await s.prize(b)).state).toBe('sending');
    expect(await runPayouts(s.deps)).toEqual([]);
    expect((await s.t.service('pokejam_pack_retry_prize', { p_id: a }) as Record<string, boolean>[])[0].pokejam_pack_retry_prize).toBe(true);
    expect(await runPayouts(s.deps)).toEqual([{ id: a, outcome: 'sent' }]);
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
    expect(blockedReason('pokemon_25', undefined)).toMatch(/isn't offering/);
    expect(machineRows(m).map((r) => r.available)).toEqual([true, false, false]);
  });

  it('runs on devnet only until kungFuDOOM approves mainnet, and only for the service key', () => {
    const env = (e: Record<string, string>) => (k: string) => e[k];
    const base = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', HOUSE_SECRET_KEY: '[1]' };
    expect(packConfig(env(base)).ccBaseUrl).toBe('https://dev-gacha.collectorcrypt.com');
    expect(packConfig(env(base)).choiceSeconds).toBe(120);
    expect(packConfig(env({ ...base, PRIZE_CHOICE_SECONDS: '0' })).choiceSeconds).toBe(0);
    expect(packConfig(env({ ...base, PRIZE_CHOICE_SECONDS: '-5' })).choiceSeconds).toBe(120);
    expect(() => packConfig(env({ ...base, CLUSTER: 'mainnet-beta' }))).toThrow(/devnet-only/);
    expect(packConfig(env({ ...base, CLUSTER: 'mainnet-beta', PACK_ALLOW_MAINNET: MAINNET_APPROVAL })).ccBaseUrl).toBe('https://gacha.collectorcrypt.com');
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
