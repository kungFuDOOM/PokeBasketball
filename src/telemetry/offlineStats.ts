// Anonymous counts of offline games (Quick Play, franchise, Season Draft) for the moderators' Stats panel
// (pokejam_log_offline, migration 20261110). Online games are already on the server, so they aren't sent here.
// What's sent: the event (a game started or finished, a season ended), the mode, played / watched / simmed, and for
// seasons how far the team went, tagged with a random id kept in this browser's localStorage. No name, account,
// fingerprint or game data. Fire-and-forget: never awaited, never throws, silent when offline.

export type OfflineMode = 'quick' | 'franchise' | 'season_draft';
export type Resolution = 'played' | 'watched' | 'simmed';

/** Under pokejam.* so the title screen's Delete saved data resets it too. */
export const DEVICE_KEY = 'pokejam.anon_device';

export interface OfflineDeps {
  send(body: Record<string, string | number | null>): Promise<unknown>;
  storage(): Pick<Storage, 'getItem' | 'setItem'> | null;
  online(): boolean;
  uuid(): string;
}

export interface OfflineGame {
  /** Logs the finish once; later calls do nothing. */
  finish(resolution?: Resolution): void;
}

export interface OfflineStats {
  /** Logs a game start (once per returned handle). */
  start(mode: OfflineMode): OfflineGame;
  /** Logs a finished season: `playoffRound` 0 = missed the playoffs, 1 = semifinal, 2 = final, 3 = champion. */
  season(mode: OfflineMode, season: number | null, playoffRound: number): void;
}

/** A random v4 UUID from crypto.getRandomValues (randomUUID needs Safari 15.4+ and https), or Math.random without it. */
export function randomUuid(): string {
  const b = new Uint8Array(16);
  try {
    crypto.getRandomValues(b);
  } catch {
    for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
  }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function makeOfflineStats(d: OfflineDeps): OfflineStats {
  /** The device id, created on first use; null (send nothing) when storage is unavailable. */
  const device = (): string | null => {
    const s = d.storage();
    if (!s) return null;
    const id = s.getItem(DEVICE_KEY);
    if (id && UUID.test(id)) return id;
    const fresh = d.uuid();
    s.setItem(DEVICE_KEY, fresh);
    return s.getItem(DEVICE_KEY) === fresh ? fresh : null;
  };
  const log = (event: 'start' | 'finish' | 'season', mode: OfflineMode, extra: { resolution?: Resolution; season?: number | null; round?: number } = {}) => {
    try {
      if (!d.online()) return;
      const id = device();
      if (!id) return;
      void d.send({
        p_device: id, p_event: event, p_mode: mode, p_resolution: extra.resolution ?? null,
        p_season: extra.season ?? null, p_playoff_round: extra.round ?? null,
      }).catch(() => {});
    } catch { /* stats never get in the way of the game */ }
  };
  return {
    start(mode) {
      log('start', mode);
      let done = false;
      return {
        finish(resolution = 'played') {
          if (done) return;
          done = true;
          log('finish', mode, { resolution });
        },
      };
    },
    season(mode, season, playoffRound) {
      log('season', mode, { season, round: playoffRound });
    },
  };
}

const NOOP: OfflineStats = { start: () => ({ finish() {} }), season() {} };
let shared: OfflineStats | null = null;

/** The game's logger: a no-op without Supabase configured or in dev. */
export function offlineStats(): OfflineStats {
  if (shared) return shared;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !key || import.meta.env.DEV) return (shared = NOOP);
  return (shared = makeOfflineStats({
    storage: () => {
      try { return localStorage; } catch { return null; }
    },
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    uuid: randomUuid,
    // A plain REST call, so the game's main bundle doesn't need supabase-js.
    send: (body) => fetch(`${url}/rest/v1/rpc/pokejam_log_offline`, {
      method: 'POST', keepalive: true,
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }));
}
