# Poké Jam

Draft five Pokémon, then play full-court 5-on-5 arcade basketball with them. NBA Jam pace and dunks, NBA 2K-style ratings, draft and shot meter, and Pokémon type matchups deciding who wins a shove.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

`dist/` is a plain static site (relative paths), so it can be hosted on GitHub Pages, Netlify or any file server. Sprites load from [PokeAPI/sprites](https://github.com/PokeAPI/sprites) at runtime.

`npm run build:artifact` also writes `dist-artifact/`, the same game with every sprite inlined as a data URI, for hosts that block third-party images.

## How it plays

Poké Jam is a franchise game. Your team and its Pokémon carry over from season to season, and progress is saved in the browser.

1. **Name your team** on the title screen and start a franchise (or continue a saved one).
2. **League draft.** You and five rival teams (Team Rocket, Aqua, Magma, Galactic and Plasma) snake-draft five Pokémon each from 48. Each card has an OVR, a position, an archetype (Floor General, Rim Protector, Stretch Big…) and eight ratings. Cover all five positions for a +2 lineup bonus. Undrafted Pokémon become free agents.
3. **Season.** Ten weeks; every team plays every other team home and away. Each week you play your game or sim it, and the other games are simulated with the same engine, so league stats are real. Difficulty and quarter length are set on the hub before each game.
4. **Hub.** Next opponent, standings, your roster's season stats, league leaders, last week's scores and league news. Once a week you can swap a player for a free agent.
5. **Leveling and evolution.** Pokémon earn XP from every game. Each level adds rating points weighted toward their position. Some evolve at set levels: Magikarp → Gyarados, Squirtle → Wartortle → Blastoise, Eevee → Jolteon/Espeon/Umbreon, Psyduck → Golduck, Slowpoke → Slowbro, Jigglypuff → Wigglytuff, Onix → Steelix.
6. **Playoffs.** The top four play semifinals (1 vs 4, 2 vs 3) and a final. Then a champion and season MVP are crowned, and the next season starts with the same rosters.

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Move | WASD / arrows | Left stick / d-pad |
| Shoot, or jump to block | J / Space: hold, release when the meter is in the green | A |
| Dunk | Hold Shift and shoot near the rim | |
| Pass, or switch defender | K. Hold Shift while passing to a teammate near the rim for an alley-oop | X |
| Steal | L. Hold Shift to shove | B |
| Turbo | Shift | Bumpers / triggers |
| Special move | I / E when the bar is full | Y |
| Pause | P / Esc | Start |

On phones the game shows a virtual stick and buttons (landscape works best).

### Systems

- **Shot meter.** Release timing sets the grade, from Excellent through Slightly Early/Late to Very Early/Late. An Excellent release is close to automatic unless the shot is heavily contested. The green window widens with the Shooting rating and when the shooter is on fire.
- **On fire.** Three straight baskets without the other team scoring sets a Pokémon on fire: unlimited turbo, a wider green window and longer dunk range.
- **Special moves.** Each Pokémon's primary type sets its special. The bar fills from scoring, assists, steals, blocks and rebounds.
  - Electric, Normal, Flying: **Surge**, unlimited turbo and more speed.
  - Psychic, Fairy, Steel: **Lock-In**, the next shot is a perfect release.
  - Ghost, Dark, Poison: **Phase**, can't be stolen from, shoved or blocked.
  - Fire, Dragon: **Blaze**, instantly on fire.
  - Ground, Rock, Fighting, Water: **Quake**, knocks down nearby opponents.
  - Ice, Grass, Bug: **Freeze**, slows the other team.
- **Type matchups.** Shoves and specials use the real type chart. Gengar is immune to a Snorlax shove (Normal can't hit Ghost), Machamp's Close Combat passes straight through Ghost-types, and super-effective hits knock opponents down for longer.

## Code map

```
src/data/pokemon.ts   roster, ratings, OVR formula, archetypes, specials, type chart
src/game/game.ts      simulation: possessions, clocks, shot meter, dunks, passes, steals, rebounds
src/game/ai.ts        CPU offense (spacing, cuts, drives, pull-ups) and defense (man-to-man, help, blocks)
src/game/render.ts    pseudo-3D court, sprites, hoops, particles on a 480×270 pixel canvas
src/game/hud.ts       scorebug, player card, Pokémon-style battle text
src/game/input.ts     keyboard, gamepad, touch
src/game/audio.ts     synthesized sound effects (no audio files)
src/franchise/league.ts  league state: schedule, standings, playoffs, XP, evolutions, free agency, save/load
src/screens/          title, draft, franchise hub, game loop, box score
```

Adding a Pokémon is one row in `ROWS` in `src/data/pokemon.ts`. OVR, archetype, size and special move are derived from that row. Evolved forms go in `EVOLVED_ROWS`, with the level they're reached at in `EVOLUTIONS`.

Add `?speed=4` to the URL to run the simulation faster when testing.

## Trailer

`trailer.html` + `src/trailer/trailer.ts` build an NBA Jam-style trailer from the real engine. Seeded CPU-vs-CPU games are scanned for highlights (alley-oops, spin dunks, blocks, players catching fire). The best ones are replayed frame by frame with slow-motion punch-ins and callouts, between title cards for the draft, type matchups, evolution and franchise mode.

```sh
npm run dev   # then open /trailer.html?play for a real-time preview (no sound)
NODE_PATH=$(npm root -g) node scripts/render-trailer.mjs   # writes trailer-out/poke-jam-trailer.mp4
```

Rendering needs Playwright with Chromium, ffmpeg (libx264 + aac) and python3 with numpy. `scripts/trailer-audio.py` composes the 120 BPM chiptune and places sound effects on the cue times the engine reports.

---

Fan-made and not affiliated with Nintendo, Game Freak or The Pokémon Company. Pokémon names and sprites belong to their owners.
