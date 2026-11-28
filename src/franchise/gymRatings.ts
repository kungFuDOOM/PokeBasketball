// Gym-only card ratings. The CPU gyms and Elite play these cards in franchise games and Quick Play; everything else
// (the draft, free agents, your own team, every other mode) uses the base cards in `data/pokemon.ts`.
import { monByDex, rerated, type Mon } from '../data/pokemon';

// dex: spd, sht, ins, pas, def, blk, reb, hnd. Comments give base OVR -> gym OVR.
const GYM_RATINGS: Readonly<Record<number, readonly [number, number, number, number, number, number, number, number]>> = {
  2: [75, 79, 74, 74, 74, 58, 58, 74], // Ivysaur 65 -> 78
  5: [73, 77, 73, 72, 73, 55, 57, 73], // Charmeleon 68 -> 76
  12: [73, 77, 73, 72, 73, 54, 55, 73], // Butterfree 67 -> 76
  26: [94, 83, 75, 81, 75, 46, 50, 89], // Raichu 87 -> 89
  34: [80, 76, 95, 70, 84, 82, 84, 68], // Nidoking 83 -> 89
  49: [77, 77, 72, 72, 72, 61, 61, 72], // Venomoth 73 -> 76
  55: [87, 89, 76, 78, 80, 55, 60, 85], // Golduck 79 -> 88
  57: [89, 84, 90, 79, 83, 56, 64, 80], // Primeape 73 -> 89
  59: [97, 83, 97, 76, 87, 74, 78, 78], // Arcanine 80 -> 92
  61: [77, 77, 72, 72, 72, 55, 60, 72], // Poliwhirl 66 -> 76
  68: [72, 58, 97, 66, 86, 88, 97, 62], // Machamp 83 -> 91
  71: [75, 76, 88, 69, 88, 79, 75, 66], // Victreebel 77 -> 84
  77: [77, 78, 74, 74, 74, 53, 56, 74], // Ponyta 70 -> 78
  82: [76, 87, 76, 76, 78, 67, 59, 76], // Magneton 74 -> 83
  93: [83, 87, 72, 72, 73, 52, 49, 76], // Haunter 75 -> 82
  97: [64, 81, 79, 90, 89, 89, 87, 62], // Hypno 75 -> 87
  103: [64, 91, 90, 77, 80, 83, 86, 65], // Exeggutor 78 -> 88
  105: [83, 88, 82, 81, 85, 62, 64, 83], // Marowak 77 -> 89
  121: [97, 89, 66, 88, 74, 50, 50, 90], // Starmie 86 -> 92
  127: [73, 56, 90, 53, 88, 80, 82, 58], // Pinsir 78 -> 83
  131: [54, 72, 80, 88, 70, 89, 93, 58], // Lapras 84 -> 88
  134: [74, 83, 89, 80, 84, 88, 94, 62], // Vaporeon 81 -> 89
  136: [68, 66, 93, 60, 76, 76, 82, 62], // Flareon 79 -> 82
  141: [87, 78, 89, 67, 89, 69, 67, 76], // Kabutops 78 -> 85
  149: [75, 71, 93, 73, 77, 90, 94, 66], // Dragonite 90 -> 92
  181: [62, 84, 87, 74, 70, 82, 84, 60], // Ampharos 77 -> 83
  196: [92, 97, 69, 92, 72, 48, 52, 91], // Espeon 84 -> 92
  205: [50, 64, 79, 59, 83, 86, 80, 54], // Forretress 77 -> 80
  214: [79, 61, 97, 59, 88, 86, 90, 62], // Heracross 83 -> 90
  217: [61, 71, 97, 67, 78, 73, 85, 61], // Ursaring 79 -> 84
  227: [73, 64, 82, 66, 91, 95, 79, 61], // Skarmory 75 -> 85
  230: [87, 95, 77, 79, 77, 62, 62, 85], // Kingdra 83 -> 90
  232: [64, 71, 97, 66, 90, 86, 93, 57], // Donphan 80 -> 91
  282: [79, 95, 70, 93, 74, 72, 66, 83], // Gardevoir 83 -> 89
  303: [79, 85, 73, 85, 91, 46, 48, 87], // Mawile 79 -> 88
  350: [70, 76, 88, 88, 82, 90, 92, 62], // Milotic 85 -> 90
  385: [89, 83, 86, 81, 88, 71, 78, 82], // Jirachi 82 -> 89
  405: [90, 81, 93, 68, 92, 72, 72, 76], // Luxray 81 -> 89
  462: [57, 77, 94, 67, 83, 97, 94, 48], // Magnezone 81 -> 91
  466: [77, 67, 97, 63, 83, 89, 92, 66], // Electivire 84 -> 91
  482: [93, 90, 90, 76, 83, 55, 70, 83], // Azelf 89 -> 92
};

const CARDS = new Map<number, Mon>(Object.entries(GYM_RATINGS).map(([dex, [spd, sht, ins, pas, def, blk, reb, hnd]]) =>
  [Number(dex), rerated(monByDex(Number(dex)), { spd, sht, ins, pas, def, blk, reb, hnd })]));

/** A Pokémon's card as a gym fields it, before level-ups: the base card unless it has gym ratings. */
export const gymMonByDex = (dex: number): Mon => CARDS.get(dex) ?? monByDex(dex);
