// End to end: a real server, two players, a live draft, a lockstep game, a payout, and the proof.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { POKEMON } from '../../src/data/pokemon';
import { packInput } from '../../src/game/sync';
import { seededRng } from '../../src/game/types';
import { LockstepClient } from '../../src/net/lockstep';
import type { BattleView, Me, PrizeView, Proof, PullView, ServerMsg } from '../../src/net/protocol';
import { createApp } from '../app';
import { CollectorCryptPackSource } from '../collector-crypt';
import { Rpc } from '../solana';
import { openDb } from '../db';
import { generateKeypair } from '../lib/ed25519';
import { MatchManager } from '../match';
import { PayoutWorker } from '../payouts';
import { verifyProof } from '../verify';
import { fakeCollectorCrypt, fakeRpc, signIn, testConfig, type FakeChain } from './helpers';

const ADMIN = 'admin-secret';
let base = '';
let stop: () => void = () => {};
let cc: Awaited<ReturnType<typeof fakeCollectorCrypt>>;
let chain: FakeChain;
let payouts: PayoutWorker;
let houseAddress = '';

beforeAll(async () => {
  const house = (await generateKeypair()).keypair;
  houseAddress = house.address;
  chain = fakeRpc();
  cc = await fakeCollectorCrypt(house.address, chain);
  const cfg = testConfig({ adminToken: ADMIN, simSpeed: 40, pickSeconds: 1, forfeitSeconds: 1, acceptTimeoutSeconds: 3 });
  const db = openDb(':memory:');
  const quiet = { ...console, info: () => {}, warn: () => {} };
  const source = new CollectorCryptPackSource({ house, rpc: new Rpc(chain.url), baseUrl: cc.url, openTimeoutMs: 5000 });
  const matches = new MatchManager(db, cfg, source);
  payouts = new PayoutWorker(db, source, { rpc: null, houseUsdcAccount: '', pollSeconds: 60 }, quiet);
  const app = createApp({ db, cfg, matches, deposits: null, payouts, houseWallet: house.address });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.websocket });
  base = `http://localhost:${server.port}`;
  stop = () => { server.stop(true); cc.stop(); chain.stop(); };
});
afterAll(() => stop());

async function player(name: string) {
  const p = await signIn(base);
  await p.api('/api/me/team', { body: { teamName: name } });
  await p.api('/api/me/eligibility', { body: { adult: true, region: 'TX' } });
  await p.api('/api/admin/credit', { body: { wallet: p.wallet, amount: 100_000_000, note: 'test funds' }, token: ADMIN });
  return p;
}

/** Connect, draft greedily, play with scripted inputs; resolves with the final battle view. */
function play(token: string, battleId: string, opts: { quitAtTick?: number; seed: number }) {
  return new Promise<{ final: BattleView; client: LockstepClient; picks: number; pull: PullView | null; sawBuying: boolean; pullBeforeStart: boolean }>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}&battle=${battleId}`);
    let side: 0 | 1 = 0;
    let client: LockstepClient | null = null;
    let picks = 0;
    let pull: PullView | null = null;
    let sawBuying = false;
    let pullBeforeStart = false;
    const r = seededRng(opts.seed);
    let timer: ReturnType<typeof setInterval> | null = null;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMsg;
      if (m.t === 'hello') {
        side = m.side;
        client = new LockstepClient(side, (msg) => ws.send(JSON.stringify(msg)));
      } else if (m.t === 'draft') {
        const turn = m.draft.order[m.draft.picks.length];
        if (turn === side && m.draft.picks.length < m.draft.order.length) {
          const best = [...POKEMON].filter((p) => !m.draft.picks.includes(p.dex)).sort((a, b) => b.ovr - a.ovr)[side];
          ws.send(JSON.stringify({ t: 'pick', dex: best.dex }));
          picks++;
        }
      } else if (m.t === 'buying') {
        sawBuying = true;
      } else if (m.t === 'pull') {
        pull = m.pull;
      } else if (m.t === 'final') {
        if (timer) clearInterval(timer);
        ws.close();
        resolve({ final: m.battle, client: client!, picks, pull, sawBuying, pullBeforeStart });
      } else if (m.t === 'error') {
        reject(new Error(m.message));
      }
      client?.handle(m);
      if (m.t === 'start' && !timer) {
        pullBeforeStart = !!pull;
        timer = setInterval(() => {
          client!.advance();
          if (opts.quitAtTick && client!.tick >= opts.quitAtTick) { clearInterval(timer!); ws.onmessage = null; ws.close(); resolve({ final: null as unknown as BattleView, client: client!, picks, pull, sawBuying, pullBeforeStart }); return; }
          const held = r() < 0.5;
          ws.send(JSON.stringify({ t: 'in', ...packInput({ mx: r() * 2 - 1, my: r() * 2 - 1, turbo: r() < 0.3, shoot: r() < 0.03, shootHeld: held, pass: r() < 0.02, steal: r() < 0.02, special: r() < 0.01, swap: false }) }));
        }, 4);
      }
    };
    ws.onerror = () => reject(new Error('socket error'));
  });
}

describe('a full paid battle', () => {
  test('both pay half, draft live, play in lockstep, the server decides, the winner gets the pull', async () => {
    const host = await player('Pallet Town');
    const guest = await player('Cerulean Cascades');
    const created = await host.api<BattleView>('/api/battles', { body: { tier: 'pokemon_50', quarterLen: 60, clientSeed: 'aa'.repeat(16) } });
    expect(created.status).toBe(200);
    expect((await host.api<Me>('/api/me')).data.balance).toBe(75_000_000);
    const open = await guest.api<BattleView[]>('/api/battles/open');
    expect(open.data.map((b) => b.id)).toContain(created.data.id);
    const acc = await guest.api<BattleView>(`/api/battles/${created.data.id}/accept`, { body: { clientSeed: 'bb'.repeat(16) } });
    expect(acc.data.state).toBe('ready');
    expect((await guest.api<Me>('/api/me')).data.balance).toBe(75_000_000);

    const [a, b] = await Promise.all([play(host.token, created.data.id, { seed: 1 }), play(guest.token, created.data.id, { seed: 2 })]);
    expect(a.picks + b.picks).toBe(10);
    expect(a.final.state).toBe('done');
    expect(a.final.forfeit).toBe(false);
    expect(a.final.score).toEqual(b.final.score);
    // Both clients' own copies of the game ended exactly where the server's did.
    for (const c of [a, b]) {
      c.client.advance();
      expect([c.client.game!.score[0], c.client.game!.score[1]]).toEqual(a.final.score!);
      expect(c.client.game!.phase).toBe('final');
    }
    expect(a.client.desyncs + b.client.desyncs).toBe(0);

    // Both players were shown the same card, bought before tip-off, while the server was buying it.
    expect(a.sawBuying && b.sawBuying).toBe(true);
    expect(a.pullBeforeStart && b.pullBeforeStart).toBe(true);
    expect(a.pull).toEqual(b.pull);
    expect(a.pull!.name).toBe('1999 Base Set Charizard PSA 10');
    expect(a.final.pull!.memo).toBe(a.pull!.memo);

    const winner = a.final.winner === 0 ? host : guest;
    await payouts.runOnce();
    const prizes = await winner.api<PrizeView[]>('/api/prizes');
    expect(prizes.data).toHaveLength(1);
    expect(prizes.data[0].state).toBe('sent');
    expect(prizes.data[0].pull!.nftAddress).toBe(a.pull!.nftAddress);
    expect(chain.assets.get(a.pull!.nftAddress)!.owner).toBe(winner.wallet);
    const loser = winner === host ? guest : host;
    expect((await loser.api<PrizeView[]>('/api/prizes')).data).toHaveLength(0);

    const proof = (await (await fetch(`${base}/api/battles/${created.data.id}/proof`)).json()) as Proof;
    expect(proof.pull!.entropy).toBe(cc.memos.get(proof.pull!.memo)!.beta);
    const verdict = await verifyProof(proof, { ccBase: cc.url });
    expect(verdict.checks.filter((c) => !c.ok)).toEqual([]);
    expect(verdict.checks.some((c) => /live/.test(c.name))).toBe(true);
    expect(verdict.ok).toBe(true);
    // Changing any source breaks it: the server seed, the VRF output, or a tick of input.
    expect((await verifyProof({ ...proof, serverSeed: 'cd'.repeat(32) }, { offline: true })).ok).toBe(false);
    expect((await verifyProof({ ...proof, pull: { ...proof.pull!, entropy: 'ee'.repeat(64) } }, { ccBase: cc.url })).ok).toBe(false);
    const tampered = { ...proof, inputs: proof.inputs.map((x, i) => (i === 900 ? [x[1], x[0]] : x)) as Proof['inputs'] };
    expect((await verifyProof(tampered, { offline: true })).replayScore).toBeDefined();
  }, 120_000);

  test('leaving mid-game forfeits to the player still there', async () => {
    const host = await player('Stayers');
    const guest = await player('Leavers');
    const b = (await host.api<BattleView>('/api/battles', { body: { tier: 'pokemon_25', quarterLen: 180 } })).data;
    await guest.api(`/api/battles/${b.id}/accept`, { body: {} });
    const [stayed] = await Promise.all([play(host.token, b.id, { seed: 3 }), play(guest.token, b.id, { seed: 4, quitAtTick: 600 })]);
    expect(stayed.final.state).toBe('done');
    expect(stayed.final.forfeit).toBe(true);
    expect(stayed.final.winner).toBe(0);
  }, 60_000);

  test('if both players leave after the pull, both are refunded and the card stays with the house', async () => {
    const host = await player('Gone One');
    const guest = await player('Gone Two');
    const b = (await host.api<BattleView>('/api/battles', { body: { tier: 'pokemon_25', quarterLen: 180 } })).data;
    await guest.api(`/api/battles/${b.id}/accept`, { body: {} });
    await Promise.all([play(host.token, b.id, { seed: 5, quitAtTick: 300 }), play(guest.token, b.id, { seed: 6, quitAtTick: 300 })]);
    await new Promise((r) => setTimeout(r, 2500));
    const after = (await host.api<BattleView>(`/api/battles/${b.id}`)).data;
    expect(after.state).toBe('void');
    expect(after.pull).not.toBeNull();
    expect(chain.assets.get(after.pull!.nftAddress)!.owner).toBe(houseAddress);
    expect((await host.api<Me>('/api/me')).data.balance).toBe(100_000_000);
    expect((await guest.api<Me>('/api/me')).data.balance).toBe(100_000_000);
    const summary = (await host.api<{ houseCards: { id: string }[] }>('/api/admin/summary', { token: ADMIN })).data;
    const card = summary.houseCards.at(-1)!;
    expect((await host.api<{ ok: boolean }>(`/api/admin/prizes/${card.id}/buyback`, { body: {}, token: ADMIN })).data.ok).toBe(true);
  }, 60_000);

  test('a no-show voids the battle and refunds both players', async () => {
    const host = await player('Early');
    const guest = await player('NoShow');
    const b = (await host.api<BattleView>('/api/battles', { body: { tier: 'pokemon_100', quarterLen: 60 } })).data;
    await guest.api(`/api/battles/${b.id}/accept`, { body: {} });
    expect((await guest.api<Me>('/api/me')).data.balance).toBe(50_000_000);
    await new Promise((r) => setTimeout(r, 3500));
    const after = await host.api<BattleView>(`/api/battles/${b.id}`);
    expect(after.data.state).toBe('void');
    expect((await host.api<Me>('/api/me')).data.balance).toBe(100_000_000);
    expect((await guest.api<Me>('/api/me')).data.balance).toBe(100_000_000);
  }, 20_000);

  test('the API refuses what it should', async () => {
    const p = await player('Checks');
    expect((await p.api('/api/battles', { body: { tier: 'pokemon_100', quarterLen: 60 }, token: 'nope' })).status).toBe(401);
    expect((await p.api('/api/battles', { body: { tier: 'pokemon_25', quarterLen: 45 } })).status).toBe(400);
    const broke = await signIn(base);
    await broke.api('/api/me/eligibility', { body: { adult: true, region: 'TX' } });
    expect((await broke.api('/api/battles', { body: { tier: 'pokemon_25', quarterLen: 60 } })).status).toBe(402);
    const kid = await signIn(base);
    await kid.api('/api/me/eligibility', { body: { adult: false, region: 'TX' } });
    expect((await kid.api('/api/battles', { body: { tier: 'pokemon_25', quarterLen: 60 } })).status).toBe(403);
    expect((await p.api('/api/admin/summary')).status).toBe(401);
    expect((await p.api('/api/admin/summary', { token: ADMIN })).status).toBe(200);
    // Withdrawals debit right away and refund on rejection.
    await p.api('/api/withdrawals', { body: { amount: 20_000_000 } });
    expect((await p.api<Me>('/api/me')).data.balance).toBe(80_000_000);
    const [w] = (await p.api<{ id: string }[]>('/api/withdrawals')).data;
    await p.api(`/api/admin/withdrawals/${w.id}`, { body: { state: 'rejected', note: 'test' }, token: ADMIN });
    expect((await p.api<Me>('/api/me')).data.balance).toBe(100_000_000);
  });
});
