import { describe, expect, it } from 'vitest';
import { makeReporter } from './errors';

const reporter = () => {
  const sent: Record<string, string | null>[] = [];
  const r = makeReporter({ send: async (b) => { sent.push(b); }, build: 'abc123', path: () => '/quick', ua: 'Test/1.0' });
  return { r, sent };
};

describe('crash reports', () => {
  it('sends the message, stack, page, build and browser, and nothing else', () => {
    const { r, sent } = reporter();
    r.report(new TypeError('boom'));
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]).sort()).toEqual(['p_build', 'p_message', 'p_path', 'p_stack', 'p_ua']);
    expect(sent[0].p_message).toBe('TypeError: boom');
    expect([sent[0].p_path, sent[0].p_build, sent[0].p_ua]).toEqual(['/quick', 'abc123', 'Test/1.0']);
  });

  it('each distinct error once per page, at most 10, and no browser-extension noise', () => {
    const { r, sent } = reporter();
    const e = new Error('same');
    for (let i = 0; i < 5; i++) r.report(e);
    expect(sent).toHaveLength(1);
    const ext = new Error('ext');
    ext.stack = 'Error: ext\n    at chrome-extension://abc/content.js:1:1';
    r.report(ext);
    r.report('Script error.');
    expect(sent).toHaveLength(1);
    for (let i = 0; i < 30; i++) { const x = new Error(`e${i}`); x.stack = `Error: e${i}\n    at f${i} (game.js:${i}:1)`; r.report(x); }
    expect(sent).toHaveLength(10);
  });

  it('copes with anything being thrown', () => {
    const { r, sent } = reporter();
    r.report({ weird: true });
    r.report(undefined);
    expect(sent.map((s) => s.p_message)).toEqual(['Error: {"weird":true}', 'Error: undefined']);
  });
});
