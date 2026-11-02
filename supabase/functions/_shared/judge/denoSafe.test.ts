// The judge's Edge Function runs the game's own code from src/ under Deno, where there is no Vite. A module in its
// import graph that touches import.meta.env or a browser global at load time crashes the function on every request, and
// vitest can't see that because it runs under Vite. So: bundle what index.ts imports with no Vite defines, and load the
// bundle in plain Node, which like Deno has no import.meta.env, window or document.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Metafile } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spriteUrl } from '../../../../src/data/pokemon';

const here = dirname(fileURLToPath(import.meta.url));
const indexFiles = ['pokejam-judge', 'pokejam-judge-worker'].map((f) => resolve(here, `../../${f}/index.ts`));

/** What the Edge Functions import from this repo. Read from index.ts, so a new import is guarded automatically. */
const localImports = () => [...new Set(indexFiles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/^import\s+(?!type\b)[^'"]*from\s+'(\.[^']+)'/gm)].map((m) => resolve(dirname(file), m[1]))))];

/** Bundle the entry files as Vite would not: import.meta.env stays as it is in the source. */
async function bundle(entries: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'judge-deno-safe-'));
  const stubs = entries.map((e, i) => `import * as m${i} from ${JSON.stringify(e)};`).join('\n');
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, `${stubs}\nconsole.log('loaded', ${entries.map((_, i) => `Object.keys(m${i}).length`).join(' + ')});\n`);
  const r = await build({ entryPoints: [entry], bundle: true, platform: 'neutral', mainFields: ['module', 'main'], format: 'esm', outfile: join(dir, 'out.mjs'), metafile: true, logLevel: 'silent' });
  return { dir, out: join(dir, 'out.mjs'), meta: r.metafile as Metafile };
}

/** Run a bundle in a plain Node process; returns its output, throws with its stderr if it crashes on load. */
const load = (file: string) => execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('the judge modules load without Vite (Deno)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllGlobals(); });

  it('reads the Edge Functions\' local imports', () => {
    const files = localImports().map((f) => f.replace(/\\/g, '/'));
    for (const f of ['handler.ts', 'deps.ts', 'worker.ts']) expect(files.some((x) => x.endsWith(`_shared/judge/${f}`)), f).toBe(true);
  });

  it('that graph includes the game code the judge replays', async () => {
    const { dir, meta } = await bundle(localImports());
    dirs.push(dir);
    expect(Object.keys(meta.inputs).some((f) => f.endsWith('src/multiplayer/shared/matchSetup.ts'))).toBe(true);
  }, 60_000);

  it('loads in a process with no import.meta.env and no browser globals', async () => {
    const { dir, out } = await bundle(localImports());
    dirs.push(dir);
    expect(load(out)).toMatch(/^loaded \d+/);
  }, 60_000);

  it('this guard does catch a module that reads import.meta.env on load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'judge-deno-unsafe-'));
    dirs.push(dir);
    const bad = join(dir, 'bad.ts');
    writeFileSync(bad, 'export const BASE = `${import.meta.env.BASE_URL}sprites`;\n');
    const b = await bundle([bad]);
    dirs.push(b.dir);
    expect(() => load(b.out)).toThrow(/BASE_URL/);
  }, 60_000);

  it('every JSON import in the graph carries the attribute Deno requires', async () => {
    const { dir, meta } = await bundle(localImports());
    dirs.push(dir);
    const json = Object.values(meta.inputs).flatMap((i) => i.imports).filter((i) => i.path.endsWith('.json'));
    expect(json.length).toBeGreaterThan(0);
    for (const i of json) expect(i.with?.type, i.path).toBe('json');
  }, 60_000);
});

describe('spriteUrl after moving BASE_URL out of module scope', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('still serves sprites from the site base', () => {
    vi.stubGlobal('window', {});
    expect(spriteUrl(25)).toBe(`${import.meta.env.BASE_URL}sprites/25.png`);
    expect(spriteUrl(25, true)).toBe(`${import.meta.env.BASE_URL}sprites/back/25.png`);
  });

  it('still prefers an inlined sprite', () => {
    vi.stubGlobal('window', { __POKE_SPRITES: { f25: 'data:image/png;base64,AA' } });
    expect(spriteUrl(25)).toBe('data:image/png;base64,AA');
  });
});
