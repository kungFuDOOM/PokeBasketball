// Older iPads and Android WebViews: the page must not blank on syntax or APIs they lack.
// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ensureRoundRect } from './compat';

const files = import.meta.glob<string>(['./**/*.ts', '!./**/*.test.ts', '!./trailer/**'], { query: '?raw', import: 'default', eager: true });
const sources = Object.keys(files);
const read = (f: string) => files[f].replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');

describe('browser compatibility', () => {
  it('builds for old Safari and Chrome, not just "modern"', () => {
    const cfg = readFileSync('vite.config.ts', 'utf8');
    expect(cfg).toMatch(/target:\s*\[[^\]]*'es2019'[^\]]*'safari12'/);
  });
  it('scans the real source files', () => expect(sources.length).toBeGreaterThan(30));
  it('source uses no syntax or APIs that throw on Safari < 16.4 / Chrome < 110 at load', () => {
    const banned: [RegExp, string][] = [
      [/\(\?<[=!]/, 'regex lookbehind (SyntaxError on Safari < 16.4)'],
      [/\.at\(-?\d/, 'Array.prototype.at (Safari < 15.4)'],
      [/structuredClone\(/, 'structuredClone (Safari < 15.4)'],
      [/\.(replaceAll|findLast|findLastIndex|toSorted|toReversed)\(/, 'ES2021+ array/string methods'],
      [/Object\.hasOwn\(/, 'Object.hasOwn (Safari < 15.4)'],
      [/crypto\.randomUUID/, 'crypto.randomUUID (Safari < 15.4, insecure contexts)'],
      [/Promise\.(any|withResolvers)/, 'Promise.any / withResolvers'],
      [/screen\.orientation\.lock|requestFullscreen\(/, 'unguarded orientation lock / fullscreen'],
      [/static\s*\{/, 'class static blocks (Safari < 16.4)'],
    ];
    for (const f of sources) {
      const code = read(f);
      for (const [re, why] of banned) expect(re.test(code), `${f}: ${why}`).toBe(false);
    }
  });
  it('css has fallbacks before dvh and color-mix', () => {
    const css = readFileSync('src/style.css', 'utf8');
    expect(css).toMatch(/100vh \* 16 \/ 9\)\);\s*width: min\(100vw, calc\(100dvh/);
    expect(css).toMatch(/@supports not \(color: color-mix/);
  });
  it('index.html loads a classic guard script before the module and a nomodule notice', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html.indexOf('boot.js')).toBeGreaterThan(0);
    expect(html.indexOf('boot.js')).toBeLessThan(html.indexOf('type="module"'));
    expect(html).toMatch(/<script nomodule src="\.\/nomodule\.js">/);
    const boot = readFileSync('public/boot.js', 'utf8');
    for (const k of ["'error'", "'unhandledrejection'", 'setTimeout', "getElementById('app')"]) expect(boot).toContain(k);
  });
  it('boot guard shows a message only while #app is empty', () => {
    const app = { children: { length: 0 } as { length: number }, innerHTML: '', querySelector: () => null };
    const listeners: Record<string, (e: unknown) => void> = {};
    const win = { addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f), setTimeout: () => 0 } as Record<string, unknown>;
    const doc = { getElementById: () => app };
    new Function('window', 'document', readFileSync('public/boot.js', 'utf8'))(win, doc);
    listeners.error({ message: 'boom', target: win });
    expect(app.innerHTML).toContain("couldn’t load");
    app.innerHTML = '';
    app.children.length = 1;
    listeners.error({ message: 'late', target: win });
    expect(app.innerHTML).toBe('');
    listeners.error({ message: 'img', target: {} });
    expect(app.innerHTML).toBe('');
    // Once the bundle has started, later errors never put the message over the game.
    app.children.length = 0;
    win.__bootOk = true;
    listeners.error({ message: 'benign', target: win });
    expect(app.innerHTML).toBe('');
  });
  it('boot guard waits for slow loads and stays quiet when the bundle starts', () => {
    const app = { children: { length: 0 }, innerHTML: '', querySelector: () => null };
    const timers: (() => void)[] = [];
    const win = { addEventListener: () => {}, setTimeout: (f: () => void) => timers.push(f) } as Record<string, unknown>;
    const doc = { getElementById: () => app, readyState: 'loading' };
    new Function('window', 'document', readFileSync('public/boot.js', 'utf8'))(win, doc);
    for (let i = 0; i < 9 && timers.length; i++) timers.shift()!(); // 18s: nothing yet
    expect(app.innerHTML).toBe('');
    win.__bootOk = true;
    while (timers.length) timers.shift()!();
    expect(app.innerHTML).toBe('');
  });
  it('boot guard and nomodule notice stay quiet while framed, leaving the framebust overlay', () => {
    const app = { children: { length: 0 }, innerHTML: '', querySelector: () => null };
    const listeners: Record<string, (e: unknown) => void> = {};
    const timers: (() => void)[] = [];
    const win = { __framed: true, addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f), setTimeout: (f: () => void) => timers.push(f) } as Record<string, unknown>;
    const doc = { getElementById: () => app, readyState: 'complete' };
    new Function('window', 'document', readFileSync('public/boot.js', 'utf8'))(win, doc);
    expect(Object.keys(listeners)).toHaveLength(0);
    expect(timers).toHaveLength(0);
    let failed = false;
    win.__bootFail = () => (failed = true);
    new Function('window', readFileSync('public/nomodule.js', 'utf8'))(win);
    expect(failed).toBe(false);
    expect(app.innerHTML).toBe('');
  });
  it('framed is the first import of every entry, then compat in main, which flags a started bundle', () => {
    for (const f of ['src/main.ts', 'src/admin/admin.ts', 'src/trailer/trailer.ts', 'src/demo/rtc-check.ts']) {
      expect(readFileSync(f, 'utf8').match(/^import [^\n]*/m)?.[0], f).toMatch(/^import '\.{1,2}\/framed';$/);
    }
    expect(readFileSync('src/main.ts', 'utf8').startsWith("import './framed';\nimport './compat';")).toBe(true);
    expect(readFileSync('src/framed.ts', 'utf8')).toMatch(/if \(typeof window !== 'undefined' && window\.__framed\) throw /);
    expect(readFileSync('src/compat.ts', 'utf8')).toContain('window.__bootOk = true');
  });
  it('roundRect fallback is installed when missing and leaves a native one alone', () => {
    const calls: string[] = [];
    const ctx = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => void calls.push(`${String(k)}:${a.length}`) });
    const proto: { roundRect?: unknown } = {};
    ensureRoundRect(proto);
    (proto.roundRect as (...a: number[]) => void).call(ctx, 0, 0, 100, 50, 10);
    expect(calls.filter((c) => c.startsWith('arcTo'))).toHaveLength(4);
    const native = () => 1;
    const p2 = { roundRect: native };
    ensureRoundRect(p2);
    expect(p2.roundRect).toBe(native);
  });
});
