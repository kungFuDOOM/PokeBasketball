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

1. **Draft.** Snake draft against Team Rocket's CPU GM: 48 Pokémon, five rounds. Each card has an OVR, a position, an archetype (Floor General, Rim Protector, Stretch Big…) and eight ratings. Cover all five positions for a +2 lineup bonus.
2. **Play.** 2-minute quarters by default, four difficulty levels, overtime on a tie. You control the ball handler on offense and any defender on defense.

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
src/screens/          menu, draft, matchup, game loop, box score
```

Adding a Pokémon is one row in `ROWS` in `src/data/pokemon.ts`. OVR, archetype, size and special move are derived from that row.

Add `?speed=4` to the URL to run the simulation faster when testing.

---

Fan-made and not affiliated with Nintendo, Game Freak or The Pokémon Company. Pokémon names and sprites belong to their owners.
