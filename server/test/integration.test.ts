// End to end: a real server, two players, a live draft, a lockstep game, a payout, and the proof.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { POKEMON } from '../../src/data/pokemon';
import { packInput } from '../../src/game/sync';
import { seededRng } from '../../src/game/types';
import { LockstepClient } from '../../src/net/lockstep';
import type { BattleView, Me, PrizeView, Proof, ServerMsg } from '../../src/net/protocol';
import { createApp } from '../app';
import { CollectorCryptPackSource, keypairWallet } from '../collector-crypt';
import { openDb } from '../db';
import { generateKeypair } from '../lib/ed25519';
import { MatchManager } from '../match';
import { PayoutWorker } from '../payouts';
import { verifyProof } from '../verify';
import { fakeCollectorCrypt, signIn, testConfig } from './helpers';

const ADMIN = 'admin-secret';
let base = '';
let stop: () => void = () => {};
let cc: Awaited<ReturnType<typeof fakeCollectorCrypt>>;
let payouts: PayoutWorker;

beforeAll(async () => {
  const house = (await generateKeypair()).keypair;
  cc = await fakeCollectorCrypt(house.address);
  const cfg = testConfig({ adminToken: ADMIN, simSpeed: 40, pickSeconds: 1, forfeitSeconds: 1, acceptTimeoutSeconds: 3 });
  const db = openDb(':memory:');
  const matches = new MatchManager(db, cfg);
  const quiet = { ...console, info: () => {}, warn: () => {} };
  payouts = new PayoutWorker(db, new CollectorCryptPackSource({ wallet: keypairWallet(house), baseUrl: cc.url, mode: 'gift' }), { rpc: null, houseUsdcAccount: '', pollSeconds: 60 }, quiet);
  const app = createApp({ db, cfg, matches, deposits: null, payouts, houseWallet: house.address });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.websocket });
  base = `http://localhost:${server.port}`;
  stop = () => { server.stop(true); cc.stop(); };
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
  return new Promise<{ final: BattleView; client: LockstepClient; picks: number }>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}&battle=${battleId}`);
    let side: 0 | 1 = 0;
    let client: LockstepClient | null = null;
    let picks = 0;
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
      } else if (m.t === 'final') {
        if (timer) clearInterval(timer);
        ws.close();
        resolve({ final: m.battle, client: client!, picks });
      } else if (m.t === 'error') {
        reject(new Error(m.message));
      }
      client?.handle(m);
      if (m.t === 'start' && !timer) {
        timer = setInterval(() => {
          client!.advance();
          if (opts.quitAtTick && client!.tick >= opts.quitAtTick) { clearInterval(timer!); ws.onmessage = null; ws.close(); resolve({ final: null as unknown as BattleView, client: client!, picks }); return; }
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

    const winner = a.final.winner === 0 ? host : guest;
    await payouts.runOnce();
    const prizes = await winner.api<PrizeView[]>('/api/prizes');
    expect(prizes.data).toHaveLength(1);
    expect(prizes.data[0].state).toBe('sent');
    expect(prizes.data[0].tier).toBe('pokemon_50');
    expect([...cc.memos.values()].at(-1)!.recipient).toBe(winner.wallet);
    const loser = winner === host ? guest : host;
    expect((await loser.api<PrizeView[]>('/api/prizes')).data).toHaveLength(0);

    const proof = (await (await fetch(`${base}/api/battles/${created.data.id}/proof`)).json()) as Proof;
    const verdict = await verifyProof(proof);
    expect(verdict.checks.filter((c) => !c.ok)).toEqual([]);
    expect(verdict.ok).toBe(true);
    // Tampering with one tick of input breaks the proof.
    const tampered = { ...proof, inputs: proof.inputs.map((x, i) => (i === 900 ? [x[1], x[0]] : x)) as Proof['inputs'] };
    const forged = { ...proof, serverSeed: 'cd'.repeat(32) };
    expect((await verifyProof(forged)).ok).toBe(false);
    expect((await verifyProof(tampered)).replayScore).toBeDefined();
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
