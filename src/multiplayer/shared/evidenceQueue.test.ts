// The evidence retry: a failed upload survives to the next start, and nothing stays past the server's window.
import { describe, expect, it, vi } from 'vitest';
import { EvidenceQueue, KEEPALIVE_MAX, MAX_AGE_MS, MAX_PACKED, uploadOnExit, type EvidenceStore, type PendingEvidence } from './evidenceQueue';

/** A stand-in for IndexedDB; the Map outlives the queue, as the database outlives a page. */
function fakeStore(): EvidenceStore & { map: Map<string, PendingEvidence> } {
  const map = new Map<string, PendingEvidence>();
  return {
    map,
    put: async (e) => void map.set(e.id, e),
    all: async () => [...map.values()],
    delete: async (id) => void map.delete(id),
  };
}

const T0 = 1_800_000_000_000;
const entry = (id: string, over: Partial<PendingEvidence> = {}): PendingEvidence => ({ id, userId: 'me', packed: `gz1:${id}`, createdAt: T0, ...over });
const uploader = (answer: () => Promise<boolean> = async () => true) => ({ userId: 'me', submitEvidence: vi.fn((_id: string, _p: string) => answer()) });
const down = async (): Promise<boolean> => { throw new Error('Failed to fetch'); };

describe('uploading after the game', () => {
  it('saves before sending and forgets once the server has it', async () => {
    const store = fakeStore();
    const q = new EvidenceQueue(store, () => T0);
    const svc = uploader(async () => {
      expect(store.map.has('m1')).toBe(true); // a closed tab from here on still has the copy
      return true;
    });
    await q.upload(entry('m1'), svc);
    expect(svc.submitEvidence).toHaveBeenCalledWith('m1', 'gz1:m1');
    expect(store.map.size).toBe(0);
  });

  it('a failed upload is kept and retried on the next start', async () => {
    const store = fakeStore();
    await new EvidenceQueue(store, () => T0).upload(entry('m1'), uploader(down));
    expect(store.map.has('m1')).toBe(true);

    const svc = uploader();
    await new EvidenceQueue(store, () => T0 + 60_000).retryPending(svc); // a new page: a new queue on the same database
    expect(svc.submitEvidence).toHaveBeenCalledWith('m1', 'gz1:m1');
    expect(store.map.size).toBe(0);
  });

  it('still uploads when storage fails or never answers', async () => {
    const broken: EvidenceStore = { put: () => Promise.reject(new Error('quota')), all: () => Promise.reject(new Error('quota')), delete: () => Promise.reject(new Error('quota')) };
    const svc = uploader();
    await new EvidenceQueue(broken, () => T0).upload(entry('m1'), svc);
    expect(svc.submitEvidence).toHaveBeenCalledTimes(1);

    const stuck: EvidenceStore = { put: () => new Promise(() => {}), all: () => new Promise(() => {}), delete: () => new Promise(() => {}) };
    const svc2 = uploader();
    void new EvidenceQueue(stuck, () => T0).upload(entry('m2'), svc2);
    await Promise.resolve();
    expect(svc2.submitEvidence).toHaveBeenCalledTimes(1);
  });

  it('keeps only the newest 3', async () => {
    const store = fakeStore();
    const q = new EvidenceQueue(store, () => T0);
    for (const n of [1, 2, 3, 4]) await q.put(entry(`m${n}`, { createdAt: T0 + n }));
    expect([...store.map.keys()].sort()).toEqual(['m2', 'm3', 'm4']);
  });

  it('does not keep what the server would refuse for size', async () => {
    const store = fakeStore();
    await new EvidenceQueue(store, () => T0).put(entry('big', { packed: 'x'.repeat(MAX_PACKED + 1) }));
    expect(store.map.size).toBe(0);
  });
});

describe('retrying on the next start', () => {
  /** A queue holding `e`, after a retry `after` ms later. */
  async function retried(e: PendingEvidence, svc: ReturnType<typeof uploader>, after = 60_000) {
    const store = fakeStore();
    store.map.set(e.id, e);
    await new EvidenceQueue(store, () => T0 + after).retryPending(svc);
    return store.map;
  }

  it('drops an expired entry without sending it', async () => {
    const svc = uploader();
    expect((await retried(entry('m1'), svc, MAX_AGE_MS)).size).toBe(0);
    expect(svc.submitEvidence).not.toHaveBeenCalled();
  });

  it('still sends one just inside the window', async () => {
    const svc = uploader();
    await retried(entry('m1'), svc, MAX_AGE_MS - 1);
    expect(svc.submitEvidence).toHaveBeenCalledTimes(1);
  });

  it('false from the service (already uploaded) deletes it', async () => {
    expect((await retried(entry('m1'), uploader(async () => false))).size).toBe(0);
  });

  it.each(['not in this match', 'bad evidence'])('the refusal "%s" is final, so it is deleted', async (message) => {
    expect((await retried(entry('m1'), uploader(() => Promise.reject(new Error(message))))).size).toBe(0);
  });

  it.each(['Failed to fetch', 'not signed in', 'too many connections'])('the error "%s" may pass, so it is kept', async (message) => {
    expect((await retried(entry('m1'), uploader(() => Promise.reject(new Error(message))))).size).toBe(1);
  });

  it('leaves another account\'s upload alone, until it expires', async () => {
    const svc = uploader();
    expect((await retried(entry('m1', { userId: 'them' }), svc)).size).toBe(1);
    expect(svc.submitEvidence).not.toHaveBeenCalled();
    expect((await retried(entry('m1', { userId: 'them' }), svc, MAX_AGE_MS)).size).toBe(0);
  });

  it('one failure does not stop the rest', async () => {
    const store = fakeStore();
    store.map.set('m1', entry('m1'));
    store.map.set('m2', entry('m2'));
    const svc = { userId: 'me', submitEvidence: vi.fn(async (id: string) => { if (id === 'm1') throw new Error('Failed to fetch'); return true; }) };
    await new EvidenceQueue(store, () => T0).retryPending(svc);
    expect([...store.map.keys()]).toEqual(['m1']);
  });

  it('does not send a match again while its first upload is still in flight', async () => {
    const store = fakeStore();
    const q = new EvidenceQueue(store, () => T0);
    let answer!: (v: boolean) => void;
    const svc = uploader(() => new Promise((r) => { answer = r; }));
    const first = q.upload(entry('m1'), svc);
    await vi.waitFor(() => expect(store.map.has('m1')).toBe(true));
    await q.retryPending(svc);
    expect(svc.submitEvidence).toHaveBeenCalledTimes(1);
    answer(true);
    await first;
    expect(store.map.size).toBe(0);
  });

  it('does nothing when storage is unavailable', async () => {
    const broken: EvidenceStore = { put: () => Promise.reject(new Error('x')), all: () => Promise.reject(new Error('x')), delete: () => Promise.reject(new Error('x')) };
    const svc = uploader();
    await expect(new EvidenceQueue(broken).retryPending(svc)).resolves.toBeUndefined();
    expect(svc.submitEvidence).not.toHaveBeenCalled();
  });
});

describe('the page closing during an upload', () => {
  it('a small upload goes out once on a keepalive request; the undo cancels it', () => {
    const win = new EventTarget();
    const send = vi.fn();
    uploadOnExit('m1', 'gz1:small', send, win);
    win.dispatchEvent(new Event('pagehide'));
    win.dispatchEvent(new Event('pagehide'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('pokejam_submit_evidence', { p_match: 'm1', p_evidence: 'gz1:small' });

    const send2 = vi.fn();
    uploadOnExit('m2', 'gz1:small', send2, win)();
    win.dispatchEvent(new Event('pagehide'));
    expect(send2).not.toHaveBeenCalled();
  });

  it('an upload too big for keepalive is left to the saved copy', () => {
    const win = new EventTarget();
    const send = vi.fn();
    uploadOnExit('m1', 'x'.repeat(KEEPALIVE_MAX), send, win);
    win.dispatchEvent(new Event('pagehide'));
    expect(send).not.toHaveBeenCalled();
  });
});
