// Searching only while the page is visible, and hooks for the page closing (bugs #2, #8).
import { describe, expect, it, vi } from 'vitest';
import { onPageExit, searchWhileVisible } from './pageExit';

/** A stand-in for `document`: an EventTarget whose visibility the test flips. */
class FakeDoc extends EventTarget {
  visibilityState = 'visible';
  set(v: 'visible' | 'hidden') {
    this.visibilityState = v;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

/** A search that waits until the test answers it, and notes each start and abort. */
function searches() {
  const log: string[] = [];
  const runs: { signal: AbortSignal; resolve: (v: string) => void; reject: (e: unknown) => void }[] = [];
  const search = (signal: AbortSignal) => new Promise<string>((resolve, reject) => {
    log.push(`start${runs.length}`);
    const i = runs.length;
    signal.addEventListener('abort', () => { log.push(`abort${i}`); reject(new DOMException('aborted', 'AbortError')); });
    runs.push({ signal, resolve, reject });
  });
  return { log, runs, search };
}

describe('searching while the page is visible', () => {
  it('pauses (and leaves the queue) in the background, resumes when back, and returns what it finds', async () => {
    const doc = new FakeDoc();
    const s = searches();
    const onHide = vi.fn();
    const onResume = vi.fn();
    const p = searchWhileVisible(new AbortController().signal, s.search, { doc, onHide, onResume });
    doc.set('hidden');
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(s.runs[0].signal.aborted).toBe(true);
    doc.set('hidden'); // a second hidden event changes nothing
    expect(onHide).toHaveBeenCalledTimes(1);
    doc.set('visible');
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(s.log).toEqual(['start0', 'abort0', 'start1']);
    s.runs[1].resolve('m1');
    expect(await p).toBe('m1');
  });

  it('Cancel (the outer signal) stops it for good, even while paused', async () => {
    const doc = new FakeDoc();
    const s = searches();
    const outer = new AbortController();
    const p = searchWhileVisible(outer.signal, s.search, { doc }).catch((e) => e);
    doc.set('hidden');
    outer.abort();
    expect((await p).name).toBe('AbortError');
    doc.set('visible');
    expect(s.runs).toHaveLength(1); // nothing restarted after the cancel
  });

  it("a real error from the search is passed on; a paused search's late answer is ignored", async () => {
    const doc = new FakeDoc();
    const s = searches();
    const p = searchWhileVisible(new AbortController().signal, s.search, { doc }).catch((e) => e);
    doc.set('hidden');
    s.runs[0].resolve('late'); // already aborted by the pause: ignored
    doc.set('visible');
    s.runs[1].reject(new Error('Slow down'));
    expect((await p).message).toBe('Slow down');
  });

  it('starting while hidden waits for the page to be visible', async () => {
    const doc = new FakeDoc();
    doc.visibilityState = 'hidden';
    const s = searches();
    const p = searchWhileVisible(new AbortController().signal, s.search, { doc });
    expect(s.runs).toHaveLength(0);
    doc.set('visible');
    s.runs[0].resolve('m');
    expect(await p).toBe('m');
  });
});

describe('the page closing', () => {
  it('runs the hook on pagehide, and not after it is removed', () => {
    const win = new EventTarget();
    const fn = vi.fn();
    const off = onPageExit(fn, win);
    win.dispatchEvent(new Event('pagehide'));
    off();
    win.dispatchEvent(new Event('pagehide'));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
