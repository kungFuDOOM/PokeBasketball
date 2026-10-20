# Poké Jam

Draft five Pokémon, then play full-court 5-on-5 arcade basketball with them. NBA Jam pace and dunks, NBA 2K-style ratings, draft and shot meter, and Pokémon type matchups deciding who wins a shove.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

`dist/` is a plain static site (relative paths), so it can be hosted on GitHub Pages, Netlify or any file server. `npm run dev` and `npm run build` first download the sprites from [PokeAPI/sprites](https://github.com/PokeAPI/sprites) into `public/sprites/` (git-ignored), so the deployed site serves them itself.

## Privacy

The game makes no requests to third parties: code, fonts (self-hosted, OFL), sprites and sound all come from the site's own host. There are no accounts, payments, analytics or cookies. Saves live in the browser's local storage under `pokejam.*` keys and can be erased with **Delete saved data** on the title screen. `public/privacy.html` is the privacy policy and terms page. Fill in its contact address before launch, and update the Hosting section if you host somewhere other than GitHub Pages. If you ever add analytics, accounts or payments, update that page first.

`npm run build:artifact` also writes `dist-artifact/`, the same game with every sprite inlined as a data URI, for hosts that block third-party images.

## How it plays

Poké Jam has two modes.

**Quick Play:** pick any Gym Leader or the Elite Four, snake-draft five Pokémon against them (60 seconds a pick), choose the venue, and play. Pure arcade: no stamina, nothing saved. Rematch, redraft or pick a new opponent afterwards.

**Franchise:** your team and its Pokémon carry over from season to season, and progress is saved in the browser.

1. **Name your team** on the title screen and start a franchise (or continue a saved one).
2. **League draft.** You draft against the eight Kanto Gym Leaders and the Elite Four: Brock's Pewter Boulders (Rock), Misty's Cerulean Cascades (Water), Lt. Surge's Vermilion Thunder (Electric), Erika's Celadon Rainbows (Grass), Koga's Fuchsia Ninjas (Poison), Sabrina's Saffron Psychics (Psychic), Blaine's Cinnabar Volcanoes (Fire), Giovanni's Viridian Quakes (Ground) and the Indigo Elite (Ice, Fighting, Ghost, Dragon). Ten teams snake-draft ten Pokémon each (five starters, five bench) from 298 (every Gen 1 and Gen 2 Pokémon plus later favorites); CPU teams favor their types. Each card has an OVR, a position, an archetype (Floor General, Rim Protector, Stretch Big…) and eight ratings. Cover all five positions for a +2 lineup bonus. You get 60 seconds per pick; when the clock runs out, the best fit is picked for you (the clock pauses while the tab is hidden). A position tracker shows how many PG, SG, SF, PF and C you have against the goal of a starter and a backup at each, and the position filters show the same counts, red where you have nobody. Undrafted Pokémon become free agents.
3. **Season.** Nine weeks; every team plays every other team once. Your schedule follows the badge journey: Brock in week 1 through Giovanni in week 8, then the Elite Four. Gyms get tougher in badge order (a rating boost from -3 for Brock to +3 for Giovanni) and the Elite Four play at +4. Each week you play your game or sim it; the other games are simulated with the same engine, so league stats are real. Difficulty and quarter length are set on the hub before each game.
4. **Stamina and subs.** Every Pokémon has a stamina rating (from its HP-heavy ratings: Snorlax runs all day, Pikachu needs breathers). Energy drains on the court, faster with turbo, and tired players lose speed and touch. The coach starts the best five that cover every position and rotates at dead balls and quarter breaks: tired players come out ("Come back, PIKACHU! Go, RAICHU!"), rested starters go back in. Sitting down cools off a player who's on fire. Starters play about 70-80% of the game. On the hub, **Edit lineup** lets you pick your starting five and bench order (the coach goes to your 6th man first); **Auto lineup** hands it back to the coach. Set **Substitutions** to Manual to run the rotation yourself: pause during a game to see everyone's energy, tap a player on the floor and one on the bench, and the sub checks in at the next dead ball.
5. **Home courts.** Every team has its own floor: paint, lines, wood, its badge at center court, a crowd in its colors and its own arena sign (Pewter's stone-gray court, Cerulean's blue floor, Cinnabar's volcanic wood, the Indigo Plateau's dark floor with gold lines…). Games are played on the home team's court.
6. **Hub.** Next opponent and their Gym Leader, a badge case (beat a gym to earn its badge; beat the Elite Four for their emblem), standings, your roster's season stats and position depth, league leaders, last week's scores and league news. Once a week you can swap a player for a free agent; the free-agent list filters by position and tags anyone who fills a need.
7. **Injuries.** Hard falls (shoves, blocks, landing from a dunk) can injure a Pokémon for 1-3 weeks, more often when it's tired. The coach subs injured players out right away, even with manual subs, and they sit out until healed.
8. **Trades.** Trade one or two players for the same number from any team until the deadline (three weeks before the playoffs) and again in the offseason. Each Gym Leader judges the offer on rating, evolution upside, injuries and their favorite type, and a meter shows how close you are.
9. **Leveling and evolution.** Pokémon earn XP from every game, more with more minutes (a DNP still earns a little from practice). Each level adds rating points weighted toward their position. Pokémon evolve along their real evolution lines at levels scaled from the games (Charmander → Charmeleon at Lv 2 → Charizard at Lv 4, Magikarp → Gyarados at Lv 3, Larvitar → Pupitar → Tyranitar, Pichu → Pikachu; stone, trade and friendship evolutions at Lv 4; Eevee picks a random Eeveelution), so cheap early picks can grow into stars.
10. **Playoffs and awards.** The top four play semifinals (1 vs 4, 2 vs 3) and a final. Then the champion is crowned along with the MVP, scoring title, Defensive Player, Sixth Man and Most Improved.
11. **Rookie draft.** Before the next season, each team picks once from the young Pokémon still in free agency, worst record first and champion last, with the same 60-second clock. Prospect cards show what each one grows into (Dratini → Dragonite 90 by Lv 6). Then every team cuts back to ten, and the next season starts with the same rosters.

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
src/franchise/league.ts  league state: schedule, standings, playoffs, XP, evolutions, injuries, awards, trades, rookie draft, free agency, save/load
src/screens/          title, draft, rookie draft, franchise hub, game loop, box score
```

Gen 1 and Gen 2 ratings are generated: `node scripts/gen-pokemon-data.mjs` reads PokeAPI's open data (base stats, height, weight, evolution chains), maps it to basketball ratings calibrated against the hand-tuned cards, picks positions from the stat profile with a small nudge for body size (Pokémon with Speed under 45 never play guard; featherweights rarely play center), and writes `src/data/generated.ts` along with every Pokémon's real height and weight. On-court size (sprite scale, reach, rebounding and shove strength) is half real body size, half inside ratings, so Steelix and Onix tower over Pichu. Court designs live in `src/data/courts.ts`.

Adding or hand-tuning a Pokémon is one row in `ROWS` in `src/data/pokemon.ts`; hand-tuned rows override generated ones. OVR, archetype, size and special move are derived from that row. Evolved forms go in `EVOLVED_ROWS`, with the level they're reached at in `EVOLUTIONS`.

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
