// Evidence that hasn't reached the server yet. The upload is sent once after the game, so a closed tab or a dead
// network used to lose it, and the judge can't rule on evidence it never got. Now the packed upload is also saved on
// this device under the match id, and the next visit to the Ranked hub retries it until the server's window closes.
// Everything here fails silently: a browser without IndexedDB (private modes, some in-app browsers) just has no retry.
import { onPageExit, type PageEvents } from './pageExit';

export interface PendingEvidence {
  /** The match id. pokejam_match_evidence keeps one upload per (match, user), so a repeat is ignored. */
  id: string;
  /** Who played it: the server only takes my own uploads, so another account on this device must not try (or drop) it. */
  userId: string;
  packed: string;
  createdAt: number;
}

export interface EvidenceStore {
  put(e: PendingEvidence): Promise<void>;
  all(): Promise<PendingEvidence[]>;
  delete(id: string): Promise<void>;
}

/** The part of the match service an upload needs. */
export interface EvidenceUploader {
  readonly userId: string;
  submitEvidence(matchId: string, packed: string): Promise<boolean>;
}

/**
 * pokejam_submit_evidence refuses a match created over 6 hours ago. The match is a little older than its upload, and
 * this device's clock can drift, so give up at 5.
 */
export const MAX_AGE_MS = 5 * 3600_000;
/** At most this many uploads are kept; a new one pushes out the oldest. */
export const MAX_ENTRIES = 3;
/** The server refuses anything larger (4 MB), so there's no point keeping it. */
export const MAX_PACKED = 4_000_000;
/** fetch keepalive allows 64 KB in flight; a typical upload is far larger and relies on the saved copy instead. */
export const KEEPALIVE_MAX = 60_000;

/** The server's refusals that a retry can't change (pokejam_submit_evidence). Anything else may be the network. */
const FINAL_REFUSAL = /not in this match|bad evidence/i;

export class EvidenceQueue {
  /** Matches being uploaded right now, so returning to the hub mid-upload doesn't send the same megabyte twice. */
  private busy = new Set<string>();

  constructor(private store: EvidenceStore, private now: () => number = Date.now) {}

  /** Save an upload, then trim to the newest MAX_ENTRIES. Never throws. */
  async put(e: PendingEvidence): Promise<void> {
    if (e.packed.length > MAX_PACKED) return;
    try {
      await this.store.put(e);
      const extra = (await this.store.all()).sort((a, b) => b.createdAt - a.createdAt).slice(MAX_ENTRIES);
      for (const old of extra) await this.store.delete(old.id);
    } catch { /* no storage here: this upload just has no second chance */ }
  }

  /** Everything saved (nothing if storage isn't available). */
  async all(): Promise<PendingEvidence[]> {
    try {
      return await this.store.all();
    } catch {
      return [];
    }
  }

  /** Forget an upload. Never throws. */
  async delete(id: string): Promise<void> {
    try {
      await this.store.delete(id);
    } catch { /* it expires on a later retry */ }
  }

  /**
   * Upload right after the game: saved first, and forgotten once the server has answered. The request doesn't wait
   * for the save, because IndexedDB can hang in some private modes and the upload matters more than the copy.
   */
  async upload(e: PendingEvidence, svc: EvidenceUploader): Promise<void> {
    if (this.busy.has(e.id)) return;
    this.busy.add(e.id);
    try {
      const saved = this.put(e);
      if (await this.settled(e, svc)) {
        await saved;
        await this.delete(e.id);
      }
    } finally {
      this.busy.delete(e.id);
    }
  }

  /** On app start: drop what's too old, and try again whatever this account still has waiting. Never throws. */
  async retryPending(svc: EvidenceUploader): Promise<void> {
    for (const e of await this.all()) {
      if (!(this.now() - e.createdAt < MAX_AGE_MS)) {
        await this.delete(e.id);
        continue;
      }
      if (e.userId !== svc.userId || this.busy.has(e.id)) continue;
      this.busy.add(e.id);
      try {
        if (await this.settled(e, svc)) await this.delete(e.id);
      } finally {
        this.busy.delete(e.id);
      }
    }
  }

  /** One try. True when there's nothing left to do: stored, already stored, or refused for good. */
  private async settled(e: PendingEvidence, svc: EvidenceUploader): Promise<boolean> {
    try {
      await svc.submitEvidence(e.id, e.packed);
      return true;
    } catch (x) {
      return FINAL_REFUSAL.test((x as Error)?.message ?? '');
    }
  }
}

/**
 * While an upload is in flight: if the page closes, try once more with a request that outlives it. Only small uploads
 * fit (KEEPALIVE_MAX); the rest rely on the saved copy. Returns the undo.
 */
export function uploadOnExit(matchId: string, packed: string, send: (fn: string, args: Record<string, unknown>) => unknown, win?: PageEvents): () => void {
  if (packed.length >= KEEPALIVE_MAX) return () => {};
  const off = onPageExit(() => {
    off();
    send('pokejam_submit_evidence', { p_match: matchId, p_evidence: packed });
  }, win);
  return off;
}

const DB = 'pokejam-evidence';
const STORE = 'pending';

/** Runs one transaction on a fresh connection (uploads are rare, and a held connection can block other tabs). */
function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => { open.result.createObjectStore(STORE, { keyPath: 'id' }); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const fail = (e: unknown) => { db.close(); reject(e); };
      try {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error); // running out of quota aborts without an error on the request
      } catch (e) {
        fail(e);
      }
    };
  });
}

export const idbStore = (): EvidenceStore => ({
  put: (e) => withStore('readwrite', (s) => s.put(e)).then(() => {}),
  all: () => withStore('readonly', (s) => s.getAll() as IDBRequest<PendingEvidence[]>),
  delete: (id) => withStore('readwrite', (s) => s.delete(id)).then(() => {}),
});

export const evidenceQueue = new EvidenceQueue(idbStore());
