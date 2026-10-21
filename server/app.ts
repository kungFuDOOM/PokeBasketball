// HTTP + WebSocket API for Pack Battles (Bun.serve).

import type { Server, ServerWebSocket } from 'bun';
import { PACK_TIERS, TIER_ORDER, US_REGIONS, type PackTier } from '../src/battles/service';
import { MICRO, type DepositView, type Me, type PrizeView, type PublicConfig, type WithdrawalView } from '../src/net/protocol';
import { HttpError, issueNonce, login, logout, sessionWallet } from './auth';
import { acceptBattle, blockedReason, cancelBattle, createBattle, entryOf, getBattle, priceOf, view, type BattleRow } from './battles';
import type { Config } from './config';
import { InsufficientFunds, balanceOf, now, post, type Db } from './db';
import type { DepositScanner } from './deposits';
import { isAddress, randomId } from './lib/bytes';
import type { MatchManager, Peer } from './match';
import type { PayoutWorker } from './payouts';

export interface AppDeps {
  db: Db;
  cfg: Config;
  matches: MatchManager;
  deposits: DepositScanner | null;
  payouts: PayoutWorker | null;
  houseWallet: string;
}

interface WsData {
  wallet: string;
  battleId: string;
  side: 0 | 1;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function createApp(d: AppDeps) {
  const { db, cfg } = d;
  const hits = new Map<string, { n: number; reset: number }>();

  const cors = (req: Request): Record<string, string> => {
    const origin = req.headers.get('origin') ?? '';
    return cfg.clientOrigins.includes(origin) || cfg.clientOrigins.includes('*')
      ? { 'access-control-allow-origin': origin || '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'origin' }
      : {};
  };

  const limited = (ip: string) => {
    const t = now();
    const h = hits.get(ip);
    if (!h || h.reset < t) { hits.set(ip, { n: 1, reset: t + 60_000 }); return false; }
    return ++h.n > cfg.rateLimitPerMinute;
  };

  const token = (req: Request) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const authed = (req: Request) => {
    const w = sessionWallet(db, token(req));
    if (!w) throw new HttpError(401, 'Sign in first');
    return w;
  };
  const admin = (req: Request) => {
    if (!cfg.adminToken || token(req) !== cfg.adminToken) throw new HttpError(401, 'Admin only');
  };
  const body = async (req: Request): Promise<Record<string, unknown>> => {
    try { return (await req.json()) as Record<string, unknown>; } catch { throw new HttpError(400, 'Expected a JSON body'); }
  };

  const me = (wallet: string): Me => {
    const u = db.query('select team_name, adult, region from users where wallet = ?').get(wallet) as { team_name: string; adult: number | null; region: string | null };
    return {
      wallet, teamName: u.team_name, balance: balanceOf(db, wallet),
      eligibility: u.adult === null || !u.region ? null : { adult: !!u.adult, region: u.region },
      blocked: blockedReason(db, cfg, wallet),
    };
  };

  const publicConfig: PublicConfig = {
    cluster: cfg.cluster, usdcMint: cfg.usdcMint, houseWallet: d.houseWallet, houseUsdcAccount: cfg.houseUsdcAccount,
    restrictedRegions: cfg.restrictedRegions, minDeposit: cfg.minDepositUsd * MICRO,
    tiers: TIER_ORDER.map((t) => ({ tier: t, price: priceOf(t), entry: entryOf(t) })),
    pickSeconds: cfg.pickSeconds,
  };

  const prizeView = (r: Record<string, unknown>): PrizeView => ({
    id: r.id as string, battleId: r.battle_id as string, tier: r.tier as PackTier, state: r.state as PrizeView['state'],
    mode: (r.mode as PrizeView['mode']) ?? null, memo: (r.memo as string) ?? null, rarity: (r.rarity as string) ?? null,
    nftAddress: (r.nft_address as string) ?? null, createdAt: r.created_at as number,
  });

  async function route(req: Request, url: URL): Promise<Response> {
    const p = url.pathname;
    const m = req.method;
    const id = /^\/api\/battles\/([\w]+)(\/\w+)?$/.exec(p);

    if (p === '/api/health') return json({ ok: true, rooms: d.matches.size });
    if (p === '/api/config' && m === 'GET') return json(publicConfig);

    // ---- auth
    if (p === '/api/auth/nonce' && m === 'GET') return json(issueNonce(db, url.searchParams.get('wallet') ?? '', url.host));
    if (p === '/api/auth/login' && m === 'POST') {
      const b = await body(req);
      return json(await login(db, String(b.wallet ?? ''), String(b.message ?? ''), String(b.signature ?? '')));
    }
    if (p === '/api/auth/logout' && m === 'POST') { const t = token(req); if (t) logout(db, t); return json({ ok: true }); }

    // ---- me
    if (p === '/api/me' && m === 'GET') return json(me(authed(req)));
    if (p === '/api/me/eligibility' && m === 'POST') {
      const w = authed(req);
      const b = await body(req);
      if (typeof b.adult !== 'boolean' || !US_REGIONS.some(([c]) => c === b.region)) throw new HttpError(400, 'Pick your state and confirm your age');
      db.query('update users set adult = ?, region = ? where wallet = ?').run(b.adult ? 1 : 0, b.region as string, w);
      return json(me(w));
    }
    if (p === '/api/me/team' && m === 'POST') {
      const w = authed(req);
      const name = String((await body(req)).teamName ?? '').replace(/[^\p{L}\p{N} .'&-]/gu, '').trim().slice(0, 20);
      if (!name) throw new HttpError(400, 'Team name needs a letter or two');
      db.query('update users set team_name = ? where wallet = ?').run(name, w);
      return json(me(w));
    }

    // ---- money
    if (p === '/api/deposits' && m === 'GET') {
      const w = authed(req);
      const rows = db.query('select signature, amount, created_at from deposits where wallet = ? order by created_at desc limit 50').all(w) as { signature: string; amount: number; created_at: number }[];
      return json(rows.map((r): DepositView => ({ signature: r.signature, amount: r.amount, createdAt: r.created_at })));
    }
    if (p === '/api/deposits/scan' && m === 'POST') {
      const w = authed(req);
      await d.deposits?.scan();
      return json(me(w));
    }
    if (p === '/api/withdrawals' && m === 'GET') {
      const w = authed(req);
      const rows = db.query('select * from withdrawals where wallet = ? order by created_at desc limit 50').all(w) as Record<string, unknown>[];
      return json(rows.map((r): WithdrawalView => ({ id: r.id as string, amount: r.amount as number, address: r.address as string, state: r.state as WithdrawalView['state'], signature: (r.signature as string) ?? null, createdAt: r.created_at as number })));
    }
    if (p === '/api/withdrawals' && m === 'POST') {
      const w = authed(req);
      const b = await body(req);
      const amount = Math.floor(Number(b.amount));
      const address = typeof b.address === 'string' && b.address ? b.address : w;
      if (!Number.isSafeInteger(amount) || amount < cfg.minWithdrawalUsd * MICRO) throw new HttpError(400, `Minimum withdrawal is $${cfg.minWithdrawalUsd}`);
      if (!isAddress(address)) throw new HttpError(400, 'Not a Solana address');
      const wid = randomId(10);
      try {
        db.transaction(() => {
          post(db, w, -amount, 'withdraw', wid);
          db.query("insert into withdrawals (id, wallet, amount, address, state, created_at, updated_at) values (?, ?, ?, ?, 'requested', ?, ?)").run(wid, w, amount, address, now(), now());
        })();
      } catch (e) {
        if (e instanceof InsufficientFunds) throw new HttpError(402, 'Not enough balance');
        throw e;
      }
      return json(me(w));
    }

    // ---- battles
    if (p === '/api/battles/open' && m === 'GET') {
      const viewer = sessionWallet(db, token(req));
      const rows = db.query("select * from battles where state = 'open' order by created_at desc limit 100").all() as BattleRow[];
      return json(rows.filter((b) => b.host !== viewer).map((b) => view(b, viewer)));
    }
    if (p === '/api/battles/mine' && m === 'GET') {
      const w = authed(req);
      const rows = db.query('select * from battles where host = ? or guest = ? order by created_at desc limit 50').all(w, w) as BattleRow[];
      return json(rows.map((b) => view(b, w)));
    }
    if (p === '/api/battles' && m === 'POST') {
      const w = authed(req);
      const b = await body(req);
      return json(view(await createBattle(db, cfg, w, b.tier, b.quarterLen, b.clientSeed), w));
    }
    if (id && id[2] === '/accept' && m === 'POST') {
      const w = authed(req);
      const b = await acceptBattle(db, cfg, w, id[1], (await body(req)).clientSeed);
      d.matches.room(b.id); // start its no-show clock now
      return json(view(b, w));
    }
    if (id && id[2] === '/cancel' && m === 'POST') {
      const w = authed(req);
      return json(view(cancelBattle(db, w, id[1]), w));
    }
    if (id && id[2] === '/proof' && m === 'GET') {
      const b = getBattle(db, id[1]);
      if (!b?.proof) throw new HttpError(404, 'No proof for this battle (yet)');
      return new Response(b.proof, { headers: { 'content-type': 'application/json' } });
    }
    if (id && !id[2] && m === 'GET') {
      const b = getBattle(db, id[1]);
      if (!b) throw new HttpError(404, 'No such battle');
      return json(view(b, sessionWallet(db, token(req))));
    }
    if (p === '/api/prizes' && m === 'GET') {
      const w = authed(req);
      return json((db.query('select * from prizes where wallet = ? order by created_at desc limit 50').all(w) as Record<string, unknown>[]).map(prizeView));
    }

    // ---- admin
    if (p.startsWith('/api/admin/')) {
      admin(req);
      if (p === '/api/admin/summary' && m === 'GET') {
        const q = (sql: string) => db.query(sql).all();
        return json({
          liabilities: (db.query('select coalesce(sum(delta), 0) as s from ledger').get() as { s: number }).s,
          battles: q('select state, count(*) as n from battles group by state'),
          prizes: q('select state, count(*) as n from prizes group by state'),
          failedPrizes: q("select id, battle_id, wallet, tier, memo, attempts, last_error from prizes where state = 'failed'"),
          withdrawals: q("select * from withdrawals where state = 'requested' order by created_at"),
          tiers: Object.fromEntries(TIER_ORDER.map((t) => [t, PACK_TIERS[t].price])),
        });
      }
      if (p === '/api/admin/unmatched-deposits' && m === 'GET') return json(db.query('select * from deposits where wallet is null and amount > 0 order by created_at desc').all());
      if (p === '/api/admin/credit' && m === 'POST') {
        const b = await body(req);
        const amount = Math.floor(Number(b.amount));
        if (!isAddress(b.wallet) || !Number.isSafeInteger(amount) || amount === 0) throw new HttpError(400, 'wallet and a nonzero integer amount (base units) required');
        db.query('insert into users (wallet, created_at) values (?, ?) on conflict(wallet) do nothing').run(b.wallet, now());
        post(db, b.wallet, amount, 'adjust', String(b.ref ?? randomId(10)), String(b.note ?? ''));
        return json({ balance: balanceOf(db, b.wallet) });
      }
      const wd = /^\/api\/admin\/withdrawals\/(\w+)$/.exec(p);
      if (wd && m === 'POST') {
        const b = await body(req);
        const row = db.query("select * from withdrawals where id = ? and state = 'requested'").get(wd[1]) as { wallet: string; amount: number } | null;
        if (!row) throw new HttpError(404, 'No open withdrawal with that id');
        db.transaction(() => {
          if (b.state === 'sent') {
            if (typeof b.signature !== 'string' || !b.signature) throw new HttpError(400, 'signature of the payout transaction required');
            db.query("update withdrawals set state = 'sent', signature = ?, updated_at = ? where id = ?").run(b.signature, now(), wd[1]);
          } else if (b.state === 'rejected') {
            db.query("update withdrawals set state = 'rejected', note = ?, updated_at = ? where id = ?").run(String(b.note ?? ''), now(), wd[1]);
            post(db, row.wallet, row.amount, 'withdraw-refund', wd[1]);
          } else throw new HttpError(400, "state must be 'sent' or 'rejected'");
        })();
        return json({ ok: true });
      }
      const pr = /^\/api\/admin\/prizes\/(\w+)\/retry$/.exec(p);
      if (pr && m === 'POST') return json({ ok: d.payouts?.retry(pr[1]) ?? false });
    }
    throw new HttpError(404, 'Not found');
  }

  return {
    async fetch(req: Request, server: Server): Promise<Response | undefined> {
      const url = new URL(req.url);
      const headers = cors(req);
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (url.pathname === '/ws') {
        const wallet = sessionWallet(db, url.searchParams.get('token'));
        const b = getBattle(db, url.searchParams.get('battle') ?? '');
        if (!wallet || !b) return json({ error: 'Sign in and pick a battle' }, 401);
        const side = b.host === wallet ? 0 : b.guest === wallet ? 1 : null;
        if (side === null) return json({ error: 'Not your battle' }, 403);
        if (server.upgrade(req, { data: { wallet, battleId: b.id, side } satisfies WsData })) return undefined;
        return json({ error: 'WebSocket upgrade failed' }, 400);
      }
      const ip = server.requestIP(req)?.address ?? 'unknown';
      if (limited(ip)) return json({ error: 'Too many requests' }, 429, headers);
      try {
        const res = await route(req, url);
        for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
        return res;
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status, headers);
        console.error(e);
        return json({ error: 'Server error' }, 500, headers);
      }
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        const room = d.matches.room(ws.data.battleId);
        if (!room) {
          const b = getBattle(db, ws.data.battleId);
          ws.send(JSON.stringify(b ? { t: 'final', battle: view(b, ws.data.wallet) } : { t: 'error', message: 'Battle not found' }));
          ws.close(1000, 'done');
          return;
        }
        room.join(ws.data.side, ws as unknown as Peer);
      },
      message(ws: ServerWebSocket<WsData>, msg: string | Uint8Array) {
        d.matches.room(ws.data.battleId)?.message(ws.data.side, typeof msg === 'string' ? msg : new TextDecoder().decode(msg));
      },
      close(ws: ServerWebSocket<WsData>) {
        d.matches.room(ws.data.battleId)?.leave(ws.data.side, ws as unknown as Peer);
      },
    },
  };
}
