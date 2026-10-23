// Builds a self-contained copy of the game in dist-artifact/ for hosts that block
// third-party images: every sprite (from public/sprites) is inlined as a data: URI.
// Run after `vite build` (npm run build:artifact does both).
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const SPRITES = new URL('../public/sprites/', import.meta.url);
const src = (await Promise.all(['pokemon.ts', 'generated.ts'].map((f) => readFile(new URL(`../src/data/${f}`, import.meta.url), 'utf8')))).join('\n');
const dexes = [...new Set([...src.matchAll(/^\s*\[(\d+), '/gm)].map((m) => Number(m[1])))];

async function dataUri(file) {
  try {
    return `data:image/png;base64,${(await readFile(new URL(file, SPRITES))).toString('base64')}`;
  } catch {
    return null;
  }
}

const sprites = {};
await Promise.all(dexes.flatMap((d) => [
  dataUri(`${d}.png`).then((u) => u && (sprites[`f${d}`] = u)),
  dataUri(`back/${d}.png`).then((u) => u && (sprites[`b${d}`] = u)),
]));

const out = new URL('../dist-artifact/', import.meta.url);
await mkdir(new URL('assets/', out), { recursive: true });
await writeFile(new URL('sprites.js', out), `window.__POKE_SPRITES=${JSON.stringify(sprites)};\n`);
await copyFile(new URL('../dist/assets/game.js', import.meta.url), new URL('assets/game.js', out));
await copyFile(new URL('../dist/assets/index.css', import.meta.url), new URL('assets/index.css', out));
// The announcer's lines, fetched by path at runtime.
await mkdir(new URL('announcer/', out), { recursive: true });
for (const f of await readdir(new URL('../public/announcer/', import.meta.url))) {
  await copyFile(new URL(`../public/announcer/${f}`, import.meta.url), new URL(`announcer/${f}`, out));
}
for (const f of await readdir(new URL('../dist/assets/', import.meta.url))) {
  if (f.endsWith('.woff2')) await copyFile(new URL(`../dist/assets/${f}`, import.meta.url), new URL(`assets/${f}`, out));
}
await copyFile(new URL('../dist/privacy.html', import.meta.url), new URL('privacy.html', out));
await writeFile(new URL('index.html', out), `<title>Poké Jam</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="assets/index.css">
<main id="app"></main>
<script src="sprites.js"></script>
<script type="module" src="assets/game.js"></script>
`);
console.log(`dist-artifact/ written with ${Object.keys(sprites).length} inlined sprites for ${dexes.length} Pokémon`);
