// Downloads every sprite the game uses into public/sprites/ so the deployed site serves them itself
// and visitors' browsers never contact a third party. Skips files that already exist.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
const src = (await Promise.all(['pokemon.ts', 'generated.ts'].map((f) => readFile(new URL(`../src/data/${f}`, import.meta.url), 'utf8')))).join('\n');
const dexes = [...new Set([...src.matchAll(/^\s*\[(\d+), '/gm)].map((m) => Number(m[1])))];
const out = new URL('../public/sprites/', import.meta.url);
await mkdir(new URL('back/', out), { recursive: true });

let fetched = 0;
await Promise.all(dexes.flatMap((d) => [`${d}.png`, `back/${d}.png`].map(async (file) => {
  const dest = new URL(file, out);
  if (existsSync(dest)) return;
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) {
    // A missing back sprite is fine: the game falls back to the front one.
    if (file.startsWith('back/')) return console.warn(`sprites: no ${file}, using the front sprite`);
    throw new Error(`${file}: HTTP ${res.status}`);
  }
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  fetched++;
})));
console.log(`sprites: ${dexes.length} Pokémon ready in public/sprites (${fetched} downloaded)`);
