export type Pos = 'PG' | 'SG' | 'SF' | 'PF' | 'C';

export type PokeType =
  | 'Normal' | 'Fire' | 'Water' | 'Electric' | 'Grass' | 'Ice'
  | 'Fighting' | 'Poison' | 'Ground' | 'Flying' | 'Psychic' | 'Bug'
  | 'Rock' | 'Ghost' | 'Dragon' | 'Dark' | 'Steel' | 'Fairy';

/** 2K-style attribute ratings, 25-99. */
export interface Ratings {
  spd: number; // speed with ball / without
  sht: number; // jump shooting, mid + three
  ins: number; // finishing: layups and dunks
  pas: number; // passing accuracy and speed
  def: number; // perimeter D, steals, shoves
  blk: number; // shot blocking
  reb: number; // rebounding and box-outs
  hnd: number; // ball handling, steal resistance
}

export type SpecialKind = 'surge' | 'lockin' | 'phase' | 'blaze' | 'quake' | 'freeze';

export interface Mon {
  dex: number;
  name: string;
  types: PokeType[];
  pos: Pos;
  r: Ratings;
  ovr: number;
  /** Body size multiplier, ~0.8 (Magikarp) to ~1.3 (Snorlax). Drives sprite size, reach and shove strength. */
  size: number;
  archetype: string;
  special: SpecialKind;
  move: string;
}

export const RATING_LABELS: Record<keyof Ratings, string> = {
  spd: 'Speed',
  sht: 'Shooting',
  ins: 'Finishing',
  pas: 'Passing',
  def: 'Perimeter D',
  blk: 'Blocking',
  reb: 'Rebounding',
  hnd: 'Handles',
};

export const SPECIALS: Record<SpecialKind, { label: string; desc: string }> = {
  surge: { label: 'Surge', desc: 'Unlimited turbo and +25% speed for 5 seconds.' },
  lockin: { label: 'Lock-In', desc: 'Next shot is a guaranteed perfect release.' },
  phase: { label: 'Phase', desc: 'Cannot be stolen from, shoved or blocked for 5 seconds.' },
  blaze: { label: 'Blaze', desc: 'Instantly catch fire.' },
  quake: { label: 'Quake', desc: 'Knocks down every opponent within 14 ft. Type matchups apply.' },
  freeze: { label: 'Freeze', desc: 'Slows the whole opposing team for 5 seconds.' },
};

/** Special move is set by the Pokémon's primary type. */
const TYPE_MOVE: Record<PokeType, [SpecialKind, string]> = {
  Electric: ['surge', 'VOLT TACKLE'],
  Normal: ['surge', 'EXTREME SPEED'],
  Flying: ['surge', 'TAILWIND'],
  Psychic: ['lockin', 'CALM MIND'],
  Fairy: ['lockin', 'MOONBLAST'],
  Steel: ['lockin', 'IRON FOCUS'],
  Ghost: ['phase', 'PHANTOM FORCE'],
  Dark: ['phase', 'SUCKER PUNCH'],
  Poison: ['phase', 'TOXIC SPIKES'],
  Fire: ['blaze', 'BLAST BURN'],
  Dragon: ['blaze', 'OUTRAGE'],
  Ground: ['quake', 'EARTHQUAKE'],
  Rock: ['quake', 'ROCK SLIDE'],
  Fighting: ['quake', 'CLOSE COMBAT'],
  Water: ['quake', 'SURF'],
  Ice: ['freeze', 'ICY WIND'],
  Grass: ['freeze', 'SLEEP POWDER'],
  Bug: ['freeze', 'STRING SHOT'],
};

const WEIGHTS: Record<Pos, Partial<Ratings>> = {
  PG: { spd: 0.2, sht: 0.2, pas: 0.2, hnd: 0.2, def: 0.1, ins: 0.1 },
  SG: { sht: 0.3, spd: 0.15, hnd: 0.15, ins: 0.15, def: 0.15, pas: 0.1 },
  SF: { sht: 0.2, ins: 0.2, def: 0.2, spd: 0.15, reb: 0.1, blk: 0.1, pas: 0.05 },
  PF: { ins: 0.25, reb: 0.2, blk: 0.15, def: 0.15, sht: 0.1, spd: 0.1, pas: 0.05 },
  C: { ins: 0.2, reb: 0.25, blk: 0.25, def: 0.1, pas: 0.1, sht: 0.05, spd: 0.05 },
};

export function overall(pos: Pos, r: Ratings): number {
  let raw = 0;
  for (const [k, w] of Object.entries(WEIGHTS[pos])) raw += r[k as keyof Ratings] * (w as number);
  return Math.max(25, Math.min(99, Math.round((raw - 60) * 1.25 + 58)));
}

function archetype(pos: Pos, r: Ratings, ovr: number): string {
  const big = pos === 'PF' || pos === 'C';
  if (ovr < 50) return 'Developmental Project';
  if (big && r.blk >= 90) return 'Rim Protector';
  if (big && r.sht >= 85) return 'Stretch Big';
  if (big && r.pas >= 82) return 'Point Center';
  if (big && r.reb >= 90) return 'Glass Cleaner';
  if (big && r.ins >= 90) return 'Post Scorer';
  if (r.sht >= 90 && r.ins >= 88) return 'Three-Level Scorer';
  if (r.sht >= 88 && r.def >= 80) return '3-and-D Wing';
  if (r.pas >= 88 && r.hnd >= 84) return 'Floor General';
  if (r.sht >= 90) return 'Sharpshooter';
  if (r.def >= 90) return 'Lockdown Defender';
  if (r.ins >= 88 && r.spd >= 84) return 'Slasher';
  if (r.spd >= 92) return 'Speedster';
  if (r.ins >= 88) return 'Rim Runner';
  if (big) return 'Hustle Big';
  return 'Role Player';
}

// dex, name, types, pos, spd, sht, ins, pas, def, blk, reb, hnd
type Row = [number, string, PokeType[], Pos, number, number, number, number, number, number, number, number];

const ROWS: Row[] = [
  [150, 'Mewtwo', ['Psychic'], 'SF', 88, 96, 95, 88, 88, 86, 84, 86],
  [25, 'Pikachu', ['Electric'], 'PG', 95, 82, 72, 85, 72, 40, 45, 92],
  [65, 'Alakazam', ['Psychic'], 'PG', 72, 96, 55, 97, 60, 50, 50, 85],
  [94, 'Gengar', ['Ghost', 'Poison'], 'SF', 86, 82, 80, 72, 96, 70, 62, 86],
  [6, 'Charizard', ['Fire', 'Flying'], 'SF', 86, 82, 95, 70, 76, 76, 74, 76],
  [658, 'Greninja', ['Water', 'Dark'], 'SG', 94, 88, 78, 80, 82, 55, 58, 88],
  [448, 'Lucario', ['Fighting', 'Steel'], 'SG', 86, 88, 82, 80, 84, 60, 62, 86],
  [445, 'Garchomp', ['Dragon', 'Ground'], 'PF', 92, 66, 96, 60, 84, 84, 82, 70],
  [149, 'Dragonite', ['Dragon', 'Flying'], 'C', 74, 70, 92, 72, 76, 88, 92, 66],
  [384, 'Rayquaza', ['Dragon', 'Flying'], 'PF', 84, 76, 96, 66, 78, 88, 90, 70],
  [151, 'Mew', ['Psychic'], 'PG', 88, 88, 80, 90, 78, 70, 68, 88],
  [887, 'Dragapult', ['Dragon', 'Ghost'], 'SG', 98, 90, 80, 76, 80, 60, 56, 86],
  [257, 'Blaziken', ['Fire', 'Fighting'], 'SF', 88, 76, 95, 68, 78, 74, 70, 80],
  [248, 'Tyranitar', ['Rock', 'Dark'], 'C', 60, 58, 94, 56, 82, 92, 92, 58],
  [143, 'Snorlax', ['Normal'], 'C', 38, 56, 90, 68, 70, 94, 98, 48],
  [9, 'Blastoise', ['Water'], 'PF', 58, 90, 82, 66, 72, 84, 86, 60],
  [131, 'Lapras', ['Water', 'Ice'], 'C', 52, 70, 78, 86, 68, 86, 90, 58],
  [376, 'Metagross', ['Steel', 'Psychic'], 'C', 58, 64, 90, 70, 84, 94, 90, 60],
  [145, 'Zapdos', ['Electric', 'Flying'], 'SF', 86, 78, 92, 68, 80, 82, 76, 74],
  [807, 'Zeraora', ['Electric'], 'SG', 98, 76, 86, 70, 80, 50, 55, 87],
  [815, 'Cinderace', ['Fire'], 'SG', 93, 86, 84, 74, 72, 52, 56, 89],
  [392, 'Infernape', ['Fire', 'Fighting'], 'SG', 92, 82, 88, 72, 74, 55, 58, 86],
  [461, 'Weavile', ['Dark', 'Ice'], 'PG', 94, 74, 64, 75, 93, 50, 52, 90],
  [196, 'Espeon', ['Psychic'], 'SG', 85, 93, 62, 86, 66, 48, 52, 84],
  [197, 'Umbreon', ['Dark'], 'SF', 78, 72, 66, 74, 93, 72, 70, 76],
  [282, 'Gardevoir', ['Psychic', 'Fairy'], 'SF', 74, 90, 66, 88, 70, 72, 66, 78],
  [212, 'Scizor', ['Bug', 'Steel'], 'SF', 80, 74, 80, 64, 92, 78, 72, 74],
  [130, 'Gyarados', ['Water', 'Flying'], 'C', 70, 54, 92, 52, 76, 90, 92, 60],
  [68, 'Machamp', ['Fighting'], 'PF', 66, 52, 93, 60, 80, 82, 90, 62],
  [59, 'Arcanine', ['Fire'], 'SF', 94, 72, 88, 66, 76, 64, 68, 78],
  [701, 'Hawlucha', ['Fighting', 'Flying'], 'SG', 90, 70, 90, 66, 76, 60, 58, 82],
  [466, 'Electivire', ['Electric'], 'PF', 72, 62, 92, 58, 78, 84, 86, 66],
  [26, 'Raichu', ['Electric'], 'PG', 93, 80, 72, 80, 70, 44, 48, 88],
  [135, 'Jolteon', ['Electric'], 'PG', 97, 80, 68, 78, 76, 42, 48, 90],
  [95, 'Onix', ['Rock', 'Ground'], 'C', 48, 40, 84, 44, 66, 96, 88, 46],
  [76, 'Golem', ['Rock', 'Ground'], 'PF', 45, 48, 88, 50, 72, 88, 86, 50],
  [3, 'Venusaur', ['Grass', 'Poison'], 'PF', 52, 60, 86, 74, 70, 86, 90, 56],
  [106, 'Hitmonlee', ['Fighting'], 'SF', 84, 68, 90, 56, 78, 72, 60, 70],
  [107, 'Hitmonchan', ['Fighting'], 'SG', 82, 74, 72, 60, 88, 60, 58, 78],
  [122, 'Mr. Mime', ['Psychic', 'Fairy'], 'PF', 64, 66, 60, 78, 90, 86, 70, 70],
  [133, 'Eevee', ['Normal'], 'PG', 82, 76, 64, 80, 68, 40, 44, 82],
  [7, 'Squirtle', ['Water'], 'PG', 80, 84, 58, 76, 70, 44, 50, 80],
  [53, 'Persian', ['Normal'], 'PG', 90, 78, 58, 76, 80, 40, 45, 86],
  [39, 'Jigglypuff', ['Normal', 'Fairy'], 'PG', 66, 74, 50, 80, 60, 30, 36, 72],
  [132, 'Ditto', ['Normal'], 'SF', 70, 70, 70, 70, 70, 70, 70, 70],
  [54, 'Psyduck', ['Water'], 'PG', 60, 64, 52, 62, 50, 40, 46, 60],
  [79, 'Slowpoke', ['Water', 'Psychic'], 'PF', 30, 72, 56, 70, 54, 62, 64, 58],
  [129, 'Magikarp', ['Water'], 'C', 40, 30, 30, 30, 30, 25, 30, 35],
];

export const POKEMON: Mon[] = ROWS.map(([dex, name, types, pos, spd, sht, ins, pas, def, blk, reb, hnd]) => {
  const r: Ratings = { spd, sht, ins, pas, def, blk, reb, hnd };
  const ovr = overall(pos, r);
  const [special, move] = TYPE_MOVE[types[0]];
  return {
    dex,
    name,
    types,
    pos,
    r,
    ovr,
    size: 0.8 + Math.max(0, (blk + reb) / 2 - 30) / 70 * 0.5,
    archetype: archetype(pos, r, ovr),
    special,
    move,
  };
});

export const POSITIONS: Pos[] = ['PG', 'SG', 'SF', 'PF', 'C'];

export const TYPE_COLORS: Record<PokeType, string> = {
  Normal: '#a8a77a', Fire: '#ee8130', Water: '#6390f0', Electric: '#f7d02c',
  Grass: '#7ac74c', Ice: '#96d9d6', Fighting: '#c22e28', Poison: '#a33ea1',
  Ground: '#e2bf65', Flying: '#a98ff3', Psychic: '#f95587', Bug: '#a6b91a',
  Rock: '#b6a136', Ghost: '#735797', Dragon: '#6f35fc', Dark: '#705746',
  Steel: '#b7b7ce', Fairy: '#d685ad',
};

// Attacking type -> [super effective against, not very effective against, no effect on]
const CHART: Record<PokeType, [PokeType[], PokeType[], PokeType[]]> = {
  Normal: [[], ['Rock', 'Steel'], ['Ghost']],
  Fire: [['Grass', 'Ice', 'Bug', 'Steel'], ['Fire', 'Water', 'Rock', 'Dragon'], []],
  Water: [['Fire', 'Ground', 'Rock'], ['Water', 'Grass', 'Dragon'], []],
  Electric: [['Water', 'Flying'], ['Electric', 'Grass', 'Dragon'], ['Ground']],
  Grass: [['Water', 'Ground', 'Rock'], ['Fire', 'Grass', 'Poison', 'Flying', 'Bug', 'Dragon', 'Steel'], []],
  Ice: [['Grass', 'Ground', 'Flying', 'Dragon'], ['Fire', 'Water', 'Ice', 'Steel'], []],
  Fighting: [['Normal', 'Ice', 'Rock', 'Dark', 'Steel'], ['Poison', 'Flying', 'Psychic', 'Bug', 'Fairy'], ['Ghost']],
  Poison: [['Grass', 'Fairy'], ['Poison', 'Ground', 'Rock', 'Ghost'], ['Steel']],
  Ground: [['Fire', 'Electric', 'Poison', 'Rock', 'Steel'], ['Grass', 'Bug'], ['Flying']],
  Flying: [['Grass', 'Fighting', 'Bug'], ['Electric', 'Rock', 'Steel'], []],
  Psychic: [['Fighting', 'Poison'], ['Psychic', 'Steel'], ['Dark']],
  Bug: [['Grass', 'Psychic', 'Dark'], ['Fire', 'Fighting', 'Poison', 'Flying', 'Ghost', 'Steel', 'Fairy'], []],
  Rock: [['Fire', 'Ice', 'Flying', 'Bug'], ['Fighting', 'Ground', 'Steel'], []],
  Ghost: [['Psychic', 'Ghost'], ['Dark'], ['Normal']],
  Dragon: [['Dragon'], ['Steel'], ['Fairy']],
  Dark: [['Psychic', 'Ghost'], ['Fighting', 'Dark', 'Fairy'], []],
  Steel: [['Ice', 'Rock', 'Fairy'], ['Fire', 'Water', 'Electric', 'Steel'], []],
  Fairy: [['Fighting', 'Dragon', 'Dark'], ['Fire', 'Poison', 'Steel'], []],
};

/** Damage multiplier of an attacking type against a defender's types (0, 0.25 … 4). */
export function effectiveness(atk: PokeType, def: PokeType[]): number {
  const [se, nve, imm] = CHART[atk];
  let m = 1;
  for (const t of def) {
    if (imm.includes(t)) return 0;
    if (se.includes(t)) m *= 2;
    else if (nve.includes(t)) m *= 0.5;
  }
  return m;
}

/** Best multiplier among the attacker's own types (a Pokémon shoves with its strongest type). */
export function bestEffectiveness(atk: PokeType[], def: PokeType[]): number {
  return Math.max(...atk.map((t) => effectiveness(t, def)));
}

const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

declare global {
  interface Window {
    __POKE_SPRITES?: Record<string, string>;
  }
}

export function spriteUrl(dex: number, back = false): string {
  const key = (back ? 'b' : 'f') + dex;
  const inline = window.__POKE_SPRITES?.[key];
  if (inline) return inline;
  return back ? `${SPRITE_BASE}/back/${dex}.png` : `${SPRITE_BASE}/${dex}.png`;
}
