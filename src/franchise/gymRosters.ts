// The franchise gyms' fixed, hand-set rosters: the themed pass in docs/gym-rosters.md. Per region, gyms in badge order,
// then the final opponent; ten dex numbers each, the team's star first. They never depend on the user's team, which may
// hold the same Pokémon.
import { monByDex, type Mon } from '../data/pokemon';
import type { RegionDef } from './regions';

export const GYM_ROSTERS: Readonly<Record<string, readonly (readonly number[])[]>> = {
  kanto: [
    // Brock: Rhydon, Gengar, Aerodactyl, Dugtrio, Onix, Golem, Venomoth, Fearow, Staryu, Dragonair
    [112, 94, 142, 51, 95, 76, 49, 22, 120, 148],
    // Misty: Blastoise, Kabutops, Rapidash, Dewgong, Poliwhirl, Weezing, Magmar, Mr. Mime, Voltorb, Weepinbell
    [9, 141, 78, 87, 61, 110, 126, 122, 100, 70],
    // Lt. Surge: Zapdos, Magneton, Cloyster, Poliwrath, Pikachu, Hitmonchan, Persian, Tentacruel, Clefable, Tangela
    [145, 82, 91, 62, 25, 107, 53, 73, 36, 114],
    // Erika: Venusaur, Victreebel, Electrode, Pinsir, Ivysaur, Hitmonlee, Butterfree, Slowbro, Eevee, Machoke
    [3, 71, 101, 127, 2, 106, 12, 80, 133, 67],
    // Koga: Articuno, Jolteon, Nidoqueen, Muk, Haunter, Ponyta, Arbok, Sandslash, Abra, Seaking
    [144, 135, 31, 89, 93, 77, 24, 28, 63, 119],
    // Sabrina: Mew, Vaporeon, Hypno, Gyarados, Kadabra, Kingler, Charmeleon, Pidgeot, Raticate, Seadra
    [151, 134, 97, 130, 64, 99, 5, 18, 20, 117],
    // Blaine: Moltres, Golduck, Lapras, Ninetales, Flareon, Electabuzz, Tauros, Vileplume, Beedrill, Metapod
    [146, 55, 131, 38, 136, 125, 128, 45, 15, 11],
    // Giovanni: Mewtwo, Raichu, Nidoking, Marowak, Exeggutor, Kangaskhan, Dodrio, Wartortle, Gastly, Kakuna
    [150, 26, 34, 105, 103, 115, 85, 8, 92, 14],
    // The Elite Four: Dragonite, Arcanine, Starmie, Machamp, Primeape, Scyther, Jynx, Omastar, Golbat, Lickitung
    [149, 59, 121, 68, 57, 123, 124, 139, 42, 108],
  ],
  johto: [
    // Falkner: Crobat, Nidoking, Gyarados, Typhlosion, Aerodactyl, Victreebel, Miltank, Jynx, Charmeleon, Mantine
    [169, 34, 130, 157, 142, 71, 241, 124, 5, 226],
    // Bugsy: Scizor, Rapidash, Scyther, Pinsir, Forretress, Kabutops, Pikachu, Rhydon, Slowking, Butterfree
    [212, 78, 123, 127, 205, 141, 25, 112, 199, 12],
    // Whitney: Snorlax, Marowak, Ursaring, Dodrio, Persian, Houndoom, Kangaskhan, Weezing, Magmar, Ledian
    [143, 105, 217, 85, 53, 229, 115, 110, 126, 166],
    // Morty: Gengar, Exeggutor, Entei, Electrode, Haunter, Ampharos, Umbreon, Hitmonchan, Blissey, Misdreavus
    [94, 103, 244, 101, 93, 181, 197, 107, 242, 200],
    // Chuck: Heracross, Primeape, Meganium, Celebi, Hitmonlee, Hypno, Muk, Ponyta, Dugtrio, Tentacruel
    [214, 57, 154, 251, 106, 97, 89, 77, 51, 73],
    // Jasmine: Steelix, Feraligatr, Ninetales, Skarmory, Magneton, Suicune, Poliwrath, Ivysaur, Arbok, Wartortle
    [208, 160, 38, 227, 82, 245, 62, 2, 24, 8],
    // Pryce: Venusaur, Machamp, Vaporeon, Raikou, Jolteon, Lapras, Flareon, Xatu, Tauros, Sneasel
    [3, 68, 134, 243, 135, 131, 136, 178, 128, 215],
    // Clair: Dragonite, Arcanine, Donphan, Kingdra, Raichu, Golduck, Nidoqueen, Dewgong, Jumpluff, Pidgeot
    [149, 59, 232, 230, 26, 55, 31, 87, 189, 18],
    // Will · Koga · Bruno · Karen · Champion Lance: Tyranitar, Lugia, Ho-Oh, Starmie, Espeon, Blastoise, Cloyster, Electabuzz, Kadabra, Stantler
    [248, 249, 250, 121, 196, 9, 91, 125, 64, 234],
  ],
  hoenn: [
    // Roxanne: Aggron, Donphan, Raichu, Kabutops, Aerodactyl, Gyarados, Victreebel, Ninjask, Poliwrath, Butterfree
    [306, 232, 26, 141, 142, 130, 71, 291, 62, 12],
    // Brawly: Hariyama, Machamp, Marowak, Sceptile, Hitmonlee, Golduck, Skarmory, Cloyster, Jynx, Arbok
    [297, 68, 105, 254, 106, 55, 227, 91, 124, 24],
    // Wattson: Manectric, Regirock, Blaziken, Magneton, Ampharos, Lapras, Rapidash, Haunter, Flareon, Umbreon
    [310, 377, 257, 82, 181, 131, 78, 93, 136, 197],
    // Flannery: Charizard, Groudon, Tyranitar, Ninetales, Houndoom, Blastoise, Scizor, Wailord, Ivysaur, Grovyle
    [6, 383, 248, 38, 229, 9, 212, 321, 2, 253],
    // Norman: Slaking, Primeape, Gardevoir, Ursaring, Tauros, Venusaur, Electrode, Pinsir, Sharpedo, Charmeleon
    [289, 57, 282, 217, 128, 3, 101, 127, 319, 5],
    // Winona: Salamence, Deoxys, Dragonite, Crobat, Dodrio, Nidoking, Steelix, Scyther, Electabuzz, Shiftry
    [373, 386, 149, 169, 85, 34, 208, 123, 125, 275],
    // Tate & Liza: Espeon, Arcanine, Jirachi, Exeggutor, Hypno, Registeel, Feraligatr, Nidoqueen, Pikachu, Kadabra
    [196, 59, 385, 103, 97, 379, 160, 31, 25, 64],
    // Juan: Starmie, Kyogre, Kingdra, Milotic, Vaporeon, Swampert, Meganium, Gengar, Swellow, Hitmonchan
    [121, 382, 230, 350, 134, 260, 154, 94, 277, 107],
    // Sidney · Phoebe · Glacia · Drake · Champion Steven: Metagross, Rayquaza, Latios, Latias, Mawile, Heracross, Jolteon, Typhlosion, Muk, Ponyta
    [376, 384, 381, 380, 303, 214, 135, 157, 89, 77],
  ],
  sinnoh: [
    // Roark: Rhyperior, Heracross, Gardevoir, Kabutops, Aerodactyl, Aggron, Crobat, Ursaring, Yanmega, Mesprit
    [464, 214, 282, 141, 142, 306, 169, 217, 469, 481],
    // Gardenia: Tangrowth, Donphan, Kingdra, Sceptile, Victreebel, Tyranitar, Jolteon, Skarmory, Houndoom, Umbreon
    [465, 232, 230, 254, 71, 248, 135, 227, 229, 197],
    // Maylene: Lucario, Machamp, Leafeon, Hariyama, Gallade, Marowak, Swampert, Mamoswine, Shaymin, Hitmonlee
    [448, 68, 470, 297, 475, 105, 260, 473, 492, 106],
    // Crasher Wake: Floatzel, Milotic, Vaporeon, Lapras, Manaphy, Primeape, Empoleon, Typhlosion, Pinsir, Manectric
    [419, 350, 134, 131, 490, 57, 395, 157, 127, 310],
    // Fantina: Mismagius, Giratina, Slaking, Gengar, Haunter, Nidoking, Heatran, Electrode, Toxicroak, Glaceon
    [429, 487, 289, 94, 93, 34, 485, 101, 454, 471],
    // Byron: Steelix, Magnezone, Mawile, Scizor, Magneton, Hippowdon, Hypno, Ninetales, Magmortar, Honchkrow
    [208, 462, 303, 212, 82, 450, 97, 38, 467, 430],
    // Candice: Weavile, Dialga, Regigigas, Arcanine, Espeon, Infernape, Venusaur, Togekiss, Nidoqueen, Ambipom
    [461, 483, 486, 59, 196, 392, 3, 468, 31, 424],
    // Volkner: Electivire, Arceus, Darkrai, Raichu, Luxray, Torterra, Golduck, Salamence, Blaziken, Roserade
    [466, 493, 491, 26, 405, 389, 55, 373, 257, 407],
    // Aaron · Bertha · Flint · Lucian · Champion Cynthia: Garchomp, Palkia, Starmie, Dragonite, Azelf, Metagross, Blastoise, Feraligatr, Porygon-Z, Rapidash
    [445, 484, 121, 149, 482, 376, 9, 160, 474, 78],
  ],
};

/** `region`'s nine CPU rosters, in the order of `regionTeams`. */
export const gymRosters = (region: RegionDef): Mon[][] => GYM_ROSTERS[region.id].map((r) => r.map(monByDex));
