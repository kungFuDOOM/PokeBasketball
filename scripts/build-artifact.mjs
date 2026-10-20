// Builds a self-contained copy of the game in dist-artifact/ for hosts that block
// third-party images: every sprite is fetched once and inlined as a data: URI.
// Run after `vite build` (npm run build:artifact does both).
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';

const BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
const src = await readFile(new URL('../src/data/pokemon.ts', import.meta.url), 'utf8');
const dexes = [...src.matchAll(/^\s*\[(\d+), '/gm)].map((m) => Number(m[1]));

async function dataUri(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
}

const sprites = {};
await Promise.all(dexes.flatMap((d) => [
  dataUri(`${BASE}/${d}.png`).then((u) => u && (sprites[`f${d}`] = u)),
  dataUri(`${BASE}/back/${d}.png`).then((u) => u && (sprites[`b${d}`] = u)),
]));

const out = new URL('../dist-artifact/', import.meta.url);
await mkdir(new URL('assets/', out), { recursive: true });
await writeFile(new URL('sprites.js', out), `window.__POKE_SPRITES=${JSON.stringify(sprites)};\n`);
await copyFile(new URL('../dist/assets/game.js', import.meta.url), new URL('assets/game.js', out));
await copyFile(new URL('../dist/assets/index.css', import.meta.url), new URL('assets/index.css', out));
await writeFile(new URL('index.html', out), `<title>Poké Jam</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=Press+Start+2P&display=swap">
<link rel="stylesheet" href="assets/index.css">
<main id="app"></main>
<script src="sprites.js"></script>
<script type="module" src="assets/game.js"></script>
`);
console.log(`dist-artifact/ written with ${Object.keys(sprites).length} inlined sprites for ${dexes.length} Pokémon`);
