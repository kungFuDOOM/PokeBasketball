// Pack Battles server. Run with `bun run start` from server/ (see server/README.md).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app';
import { voidInterrupted } from './battles';
import { CollectorCryptPackSource, keypairWallet } from './collector-crypt';
import { loadConfig } from './config';
import { openDb } from './db';
import { DepositScanner } from './deposits';
import { keypairFromSecret } from './lib/ed25519';
import { MatchManager } from './match';
import { PayoutWorker } from './payouts';
import { Rpc } from './solana';

const cfg = loadConfig();
if (cfg.dbPath !== ':memory:') mkdirSync(dirname(cfg.dbPath), { recursive: true });
const db = openDb(cfg.dbPath);

const voided = voidInterrupted(db);
if (voided) console.warn(`${voided} battle(s) were mid-game when the server stopped; both players refunded`);

const rpc = new Rpc(cfg.rpcUrl);
const house = cfg.houseSecret ? await keypairFromSecret(cfg.houseSecret) : null;
if (!house) console.warn('HOUSE_SECRET_KEY not set: prizes will queue but not be sent');
if (!cfg.houseUsdcAccount) console.warn('HOUSE_USDC_ACCOUNT not set: deposits will not be detected');

const source = house ? new CollectorCryptPackSource({ wallet: keypairWallet(house), baseUrl: cfg.ccBaseUrl, apiKey: cfg.ccApiKey, mode: cfg.payoutMode }) : null;
const payouts = new PayoutWorker(db, source, { rpc, houseUsdcAccount: cfg.houseUsdcAccount, pollSeconds: cfg.payoutPollSeconds });
payouts.recover();
const deposits = cfg.houseUsdcAccount ? new DepositScanner(db, rpc, cfg) : null;

const matches = new MatchManager(db, cfg);
matches.onFinish = () => void payouts.runOnce();
matches.resume();

const app = createApp({ db, cfg, matches, deposits, payouts, houseWallet: house?.address ?? '' });
const server = Bun.serve({ port: cfg.port, fetch: app.fetch, websocket: app.websocket });
deposits?.start();
payouts.start();
console.log(`Pack Battles server on :${server.port} (${cfg.cluster}, payouts ${cfg.payoutMode}, house ${house?.address ?? 'unset'})`);

const shutdown = () => {
  console.log('shutting down: voiding live battles and refunding');
  matches.stopAll();
  server.stop();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
