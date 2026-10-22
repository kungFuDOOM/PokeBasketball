// Generates src/data/generated.ts: basketball ratings for every Gen 1 and Gen 2 Pokémon (#1-251), derived
// from base stats, height and weight in PokeAPI's open CSV data, plus evolution rules for franchise mode.
// Hand-tuned rows in src/data/pokemon.ts take precedence and are used to calibrate the scale.
// Usage: node scripts/gen-pokemon-data.mjs
import { readFile, writeFile } from 'node:fs/promises';

const CSV = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv';
const MAX_DEX = 251;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const load = async (name) => parseCsv(await (await fetch(`${CSV}/${name}.csv`)).text());
const [pokemon, stats, ptypes, types, species, names, evolution] = await Promise.all(
  ['pokemon', 'pokemon_stats', 'pokemon_types', 'types', 'pokemon_species', 'pokemon_species_names', 'pokemon_evolution'].map(load),
);

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const typeName = Object.fromEntries(types.map((t) => [t.id, cap(t.identifier)]));
const STAT = { 1: 'hp', 2: 'atk', 3: 'def', 4: 'spa', 5: 'spd', 6: 'spe' };
const base = {};
for (const s of stats) (base[s.pokemon_id] ??= {})[STAT[s.stat_id]] = Number(s.base_stat);
const typesOf = {};
for (const t of ptypes) (typesOf[t.pokemon_id] ??= [])[Number(t.slot) - 1] = typeName[t.type_id];
const body = Object.fromEntries(pokemon.filter((p) => p.is_default === '1').map((p) => [p.species_id, { h: Number(p.height) / 10, w: Number(p.weight) / 10, id: p.id }]));
const nameOf = Object.fromEntries(names.filter((n) => n.local_language_id === '9').map((n) => [n.pokemon_species_id, n.name]));
const speciesById = Object.fromEntries(species.map((s) => [s.id, s]));

// Hand-tuned rows: kept as-is, and used to calibrate the generated scale.
// Rows after `const RETIRED_ROWS` are retired and skipped; everything before it is hand-tuned.
const fullSrc = await readFile(new URL('../src/data/pokemon.ts', import.meta.url), 'utf8');
const handSrc = fullSrc.slice(0, fullSrc.indexOf('const RETIRED_ROWS'));
const KEYS = ['spd', 'sht', 'ins', 'pas', 'def', 'blk', 'reb', 'hnd'];
const hand = {};
for (const m of handSrc.matchAll(/^\s*\[(\d+), '[^']*', \[[^\]]*\], '\w+', ([\d, ]+)\],/gm)) {
  const v = m[2].split(',').map((x) => Number(x.trim()));
  hand[m[1]] = Object.fromEntries(KEYS.map((k, i) => [k, v[i]]));
}

const n = (x) => 25 + x * 0.55;
/** Base stats + body to raw basketball ratings, before calibration. */
function rawRatings(id) {
  const s = base[body[id].id];
  const { h, w } = body[id];
  return {
    spd: n(s.spe) + 4,
    sht: n(s.spa * 0.85 + s.spe * 0.15),
    ins: n(s.atk * 0.8 + s.hp * 0.2) + Math.min(6, h * 3),
    pas: n(s.spd * 0.5 + s.spa * 0.3 + s.spe * 0.2),
    def: n(s.def * 0.45 + s.spe * 0.35 + s.atk * 0.2),
    blk: n(s.def * 0.5 + s.spd * 0.2 + s.hp * 0.1) + Math.min(18, h * 6),
    reb: n(s.hp * 0.6 + s.def * 0.2 + s.atk * 0.2) + Math.min(15, w / 30),
    hnd: n(s.spe * 0.6 + s.spa * 0.2 + s.spd * 0.2),
  };
}

// Per-rating least squares fit of hand-tuned values against raw values, over Pokémon that have both.
const overlap = Object.keys(hand).filter((d) => Number(d) <= MAX_DEX && body[d]);
const fit = {};
for (const k of KEYS) {
  const xs = overlap.map((d) => rawRatings(d)[k]);
  const ys = overlap.map((d) => hand[d][k]);
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  const my = ys.reduce((a, b) => a + b) / ys.length;
  let sxy = 0;
  let sxx = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
  const a = Math.min(1.4, Math.max(0.7, sxy / sxx));
  fit[k] = { a, b: my - a * mx };
}
// The fit is pinned so that hand-tuning one card doesn't nudge every generated rating by rounding.
// Run with --refit to recompute it from the hand-tuned cards and print new values to paste here.
const PINNED = {
  spd: { a: 1.0208423173235024, b: -3.123819456362 },
  sht: { a: 0.7, b: 22.103930921052616 },
  ins: { a: 0.8499281088186554, b: 12.300424237179243 },
  pas: { a: 0.7839188935848124, b: 12.853083956301923 },
  def: { a: 0.76968325706196, b: 21.236484505345203 },
  blk: { a: 1.2304151841037085, b: -16.238079950360486 },
  reb: { a: 0.9902352487860112, b: -0.8984569415672325 },
  hnd: { a: 0.8140193861924382, b: 12.309045176508675 },
};
if (process.argv.includes('--refit')) console.log('fit', JSON.stringify(fit));
else Object.assign(fit, PINNED);
const clamp = (v) => Math.max(20, Math.min(99, Math.round(v)));
const ratings = (id) => {
  const r = rawRatings(id);
  return Object.fromEntries(KEYS.map((k) => [k, clamp(fit[k].a * r[k] + fit[k].b)]));
};

// Same weights as overall() in pokemon.ts.
const WEIGHTS = {
  PG: { spd: 0.2, sht: 0.2, pas: 0.2, hnd: 0.2, def: 0.1, ins: 0.1 },
  SG: { sht: 0.3, spd: 0.15, hnd: 0.15, ins: 0.15, def: 0.15, pas: 0.1 },
  SF: { sht: 0.2, ins: 0.2, def: 0.2, spd: 0.15, reb: 0.1, blk: 0.1, pas: 0.05 },
  PF: { ins: 0.25, reb: 0.2, blk: 0.15, def: 0.15, sht: 0.1, spd: 0.1, pas: 0.05 },
  C: { ins: 0.2, reb: 0.25, blk: 0.25, def: 0.1, pas: 0.1, sht: 0.05, spd: 0.05 },
};
/**
 * Best position for the profile, nudged by body size so tiny Pokémon lean guard and giants lean inside.
 * The nudge is small: a slow, tiny wall like Shuckle still plays center because its ratings say so.
 * Slow Pokémon (Speed under 45) never play guard.
 */
function position(r, h, w) {
  const size = h < 0.7 ? 0 : h < 1.2 ? 1 : h < 2 ? 2 : 3;
  const heavy = w > 200;
  const bias = [
    { PG: 3, SG: 2, SF: 0, PF: -3, C: -6 },
    { PG: 1, SG: 1, SF: 1, PF: 0, C: -2 },
    { PG: -2, SG: -1, SF: 1, PF: 1, C: 1 },
    { PG: -5, SG: -4, SF: -1, PF: 2, C: 4 },
  ][heavy ? 3 : size];
  let best = 'SF';
  let bs = -Infinity;
  for (const [pos, wts] of Object.entries(WEIGHTS)) {
    if (r.spd < 45 && (pos === 'PG' || pos === 'SG')) continue;
    // Featherweights don't bang inside.
    const light = pos === 'C' ? (w < 15 ? -5 : w < 60 ? -2 : 0) : pos === 'PF' && w < 15 ? -2 : 0;
    const s = Object.entries(wts).reduce((a, [k, v]) => a + r[k] * v, 0) + bias[pos] + light;
    if (s > bs) { bs = s; best = pos; }
  }
  return best;
}

const rows = [];
for (let id = 1; id <= MAX_DEX; id++) {
  if (hand[id]) continue;
  const r = ratings(id);
  const name = nameOf[id].replace(/'/g, '’');
  const t = typesOf[body[id].id].filter(Boolean);
  rows.push(`  [${id}, '${name}', [${t.map((x) => `'${x}'`).join(', ')}], '${position(r, body[id].h, body[id].w)}', ${KEYS.map((k) => r[k]).join(', ')}],`);
}

// Evolutions between any two Pokémon the game has: level from the games' minimum level (Lv 16 -> 2, Lv 36 -> 4),
// and Lv 4 for stones, trades and friendship.
const have = new Set([...Array.from({ length: MAX_DEX }, (_, i) => String(i + 1)), ...Object.keys(hand)]);
const evo = {};
for (const s of species) {
  const from = s.evolves_from_species_id;
  if (!from || !have.has(s.id) || !have.has(from)) continue;
  const ev = evolution.find((e) => e.evolved_species_id === s.id);
  const lv = ev?.minimum_level ? Math.max(2, Math.min(6, Math.ceil(Number(ev.minimum_level) / 9))) : 4;
  const e = (evo[from] ??= { level: lv, to: [] });
  e.level = Math.min(e.level, lv);
  e.to.push(Number(s.id));
}
const evoLines = Object.entries(evo)
  .sort(([a], [b]) => a - b)
  .map(([from, e]) => `  ${from}: { level: ${e.level}, to: [${e.to.join(', ')}] }, // ${nameOf[from] ?? from} -> ${e.to.map((t) => nameOf[t] ?? t).join(' / ')}`);

// Height (m) and weight (kg) of every Pokémon in the game, hand-tuned ones included: drives on-court size.
const bodyLines = [...have].map(Number).sort((a, b) => a - b).filter((d) => body[d]).map((d) => `${d}: [${body[d].h}, ${body[d].w}]`);
const bodyText = bodyLines.reduce((acc, item) => {
  const last = acc[acc.length - 1];
  if (last && last.length + item.length < 108) acc[acc.length - 1] = `${last} ${item},`;
  else acc.push(`  ${item},`);
  return acc;
}, []).join('\n');

const out = `// Generated by scripts/gen-pokemon-data.mjs from PokeAPI's open data (base stats, height and weight
// mapped to basketball ratings). Do not edit by hand: hand-tuned rows in pokemon.ts take precedence.
import type { Row } from './pokemon';

// dex, name, types, pos, spd, sht, ins, pas, def, blk, reb, hnd
export const GENERATED_ROWS: Row[] = [
${rows.join('\n')}
];

/** Evolutions by franchise level. \`to\` lists candidates; one is picked at random. */
export const GENERATED_EVOLUTIONS: Record<number, { level: number; to: number[] }> = {
${evoLines.join('\n')}
};

/** Height in meters and weight in kg, by dex number. */
export const GENERATED_BODY: Record<number, [number, number]> = {
${bodyText}
};
`;
await writeFile(new URL('../src/data/generated.ts', import.meta.url), out);
console.log(`generated.ts: ${rows.length} generated rows (${Object.keys(hand).length} hand-tuned kept), ${evoLines.length} evolution rules`);
console.log('calibration', Object.fromEntries(KEYS.map((k) => [k, `${fit[k].a.toFixed(2)}x + ${fit[k].b.toFixed(1)}`])));
