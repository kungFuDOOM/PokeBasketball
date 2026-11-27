# Poké Jam

Draft five Pokémon, then play full-court 5-on-5 arcade basketball with them. NBA Jam pace and dunks, NBA 2K-style ratings, draft and shot meter, and Pokémon type matchups deciding who wins a shove.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

`dist/` is a plain static site (relative paths), so it can be hosted on GitHub Pages, Netlify or any file server. The live site is https://pokejam.xyz/: `.github/workflows/pages.yml` builds and deploys it on every push (one-time setup: repo Settings → Pages → Source: GitHub Actions). `npm run dev` and `npm run build` first download the sprites from [PokeAPI/sprites](https://github.com/PokeAPI/sprites) into `public/sprites/` (git-ignored), so the deployed site serves them itself.

## Privacy

The game makes no requests to third parties: code, fonts (self-hosted, OFL), sprites and sound all come from the site's own host. There are no accounts, payments, analytics or cookies. Saves live in the browser's local storage under `pokejam.*` keys and can be erased with **Delete saved data** on the title screen. `public/privacy.html` is the privacy policy and terms page. `public/terms.html` is the standalone terms page. Update the Hosting section if you host somewhere other than GitHub Pages. If you ever add analytics, accounts or payments, update that page first.

The app icon is `public/icon.svg` (PNG sizes and `apple-touch-icon.png` are rendered from it), and `public/og.png` is the 1200×630 link-preview card. The link-preview tags in `index.html` use absolute URLs, so update them if the site moves to a custom domain.

`npm run build:artifact` also writes `dist-artifact/`, the same game with every sprite inlined as a data URI, for hosts that block third-party images.

## Security

See [SECURITY.md](SECURITY.md): a Content Security Policy on every page, escaped output, saves checked on load, a locked-down deploy pipeline with `npm audit` and Dependabot, and how to put Cloudflare in front for DDoS protection and full security headers once the site has its own domain.

## How it plays

Poké Jam has two modes.

**Quick Play:** pick any Gym Leader or the Elite Four, snake-draft five Pokémon against them (60 seconds a pick), choose the venue, and play. Pure arcade: no stamina, nothing saved. Rematch, redraft or pick a new opponent afterwards.

**Roster:** browse every Pokémon from the title screen: sort by any rating, filter by position or type, search, and tap one for its full card with special move, stamina, size and evolution.

**Franchise:** your team and its Pokémon carry over from season to season, and progress is saved in the browser.

**Season Draft:** draft ten Pokémon with the regular draft screen, then your team plays a full simulated season (a fast stat-based sim, `src/season/sim.ts`) and the playoffs. You get a record, standings, a grade and a Player of the Season, plus a share image and a share link (the team is packed into the URL hash, no server). The ten are saved as "My Drafted Team" (`docs/drafted-team.md`) and can be used in Quick Play and Franchise. Title screen: a live CPU-vs-CPU game plays behind the menu (off with reduced motion).

`npm test` runs the unit tests (season sim, share links).

1. **Name your team** on the title screen and start a franchise (or continue a saved one).
2. **League draft.** You draft against the eight Kanto Gym Leaders and the Elite Four: Brock's Pewter Boulders (Rock), Misty's Cerulean Cascades (Water), Lt. Surge's Vermilion Thunder (Electric), Erika's Celadon Rainbows (Grass), Koga's Fuchsia Ninjas (Poison), Sabrina's Saffron Psychics (Psychic), Blaine's Cinnabar Volcanoes (Fire), Giovanni's Viridian Quakes (Ground) and the Indigo Elite (Ice, Fighting, Ghost, Dragon). Ten teams snake-draft ten Pokémon each (five starters, five bench) from the franchise pool: every Gen 1 Pokémon, favorites from Gens 3-5 and a few later picks (Tyrantrum and Tinkaton), plus Gen 2 and Gen 3 once their regions are unlocked (Quick Play drafts from all 412); CPU teams favor their types. The Kanto gyms and Indigo Elite are the exception: they draft by the [gym draft rules](#gym-drafts) below. Each card has an OVR, a position, an archetype (Floor General, Rim Protector, Stretch Big…) and eight ratings. Cover all five positions for a +2 lineup bonus. You get 60 seconds per pick; when the clock runs out, the best fit is picked for you (the clock pauses while the tab is hidden). A position tracker shows how many PG, SG, SF, PF and C you have against the goal of a starter and a backup at each, and the position filters show the same counts, red where you have nobody. Undrafted Pokémon become free agents.
3. **Season.** Nine weeks; every team plays every other team once. Your schedule follows the badge journey: Brock in week 1 through Giovanni in week 8, then the Elite Four. Gyms get tougher in badge order: each team's game strength is its card OVR plus a small fixed rating boost, 0 to 4 for a gym and up to 6 for the Elite Four (the Kanto Elite Four play at +6, shown on the matchup card as "+6 team boost"). It is set never to drop from badge to badge, with a clear step up to the Elite Four. A gym's boost is the same however strong your team is. Each week you play your game or sim it; the other games are simulated with the same engine, so league stats are real. Difficulty and quarter length are set on the hub before each game.
4. **Stamina and subs.** Every Pokémon has a stamina rating (from its HP-heavy ratings: Snorlax runs all day, Pikachu needs breathers). Energy drains on the court, faster with turbo, and tired players lose speed and touch. The coach starts the best Pokémon at each position (a position nobody plays goes to the nearest one: an SG or PF covers SF) and rotates at dead balls and quarter breaks: tired players come out ("Come back, PIKACHU! Go, RAICHU!"), rested starters go back in. Sitting down cools off a player who's on fire. Starters play about 70-80% of the game. On the hub, **Edit lineup** lets you pick your starting five and bench order (the coach goes to your 6th man first); **Auto lineup** hands it back to the coach. Set **Substitutions** to Manual to run the rotation yourself: pause during a game to see everyone's energy, tap a player on the floor and one on the bench, and the sub checks in at the next dead ball.
5. **Home courts.** Every team has its own floor: paint, lines, wood, its badge at center court, a crowd in its colors and its own arena sign (Pewter's stone-gray court, Cerulean's blue floor, Cinnabar's volcanic wood, the Indigo Plateau's dark floor with gold lines…). Games are played on the home team's court.
6. **Hub.** Next opponent and their Gym Leader, every game of the season with full box scores (also one tap from the results after your game), a badge case (beat a gym to earn its badge; beat the Elite Four for their emblem), standings, your roster's season stats and position depth, league leaders, last week's scores and league news. Once a week you can swap a player for a free agent; the free-agent list filters by position and tags anyone who fills a need.
7. **Injuries.** Hard falls (shoves, blocks, landing from a dunk) can injure a Pokémon for 1-3 weeks, more often when it's tired. The coach subs injured players out right away, even with manual subs, and they sit out until healed.
8. **Trades.** Trade one or two players for the same number from any team until the deadline (three weeks before the playoffs) and again in the offseason. Each Gym Leader judges the offer on rating, evolution upside, injuries and their favorite type, and a meter shows how close you are.
9. **Leveling and evolution.** Pokémon earn XP from every game, more with more minutes (a DNP still earns a little from practice). Each level adds rating points weighted toward their position. Pokémon evolve along their real evolution lines at levels scaled from the games (Charmander → Charmeleon at Lv 2 → Charizard at Lv 4, Magikarp → Gyarados at Lv 3, Larvitar → Pupitar → Tyranitar, Pichu → Pikachu; stone, trade and friendship evolutions at Lv 4; Eevee picks a random Eeveelution), so cheap early picks can grow into stars.
10. **Playoffs and awards.** The top four play semifinals (1 vs 4, 2 vs 3) and a final. Then the champion is crowned along with the MVP, scoring title, Defensive Player, Sixth Man and Most Improved.
11. **Rookie draft.** Before the next season, each team picks once from the young Pokémon still in free agency, worst record first and champion last, with the same 60-second clock. Prospect cards show what each one grows into (Dratini → Dragonite 90 by Lv 6). Then every team cuts back to ten, and the next season starts with the same rosters.
12. **Regions.** Win all eight gym badges and the title in the same season to unlock the next region: Kanto opens Johto (Falkner to Clair, then Lance), Johto opens Hoenn (Roxanne to Juan, then the Hoenn Elite Four & Champion Steven), Hoenn opens Sinnoh (Roark to Volkner, then the Sinnoh Elite Four & Champion Cynthia). Johto, Hoenn and Sinnoh gyms and finals are built the same way as Kanto's, by the [gym draft rules](#gym-drafts). Their gym boosts are 0 to 4 and their final opponents' up to 6, with no extra hidden scaling to your roster. They draft when you enter the region, and a save from before this rebuilds the current region's nine teams once, without touching your team. An unlocked region adds its Pokémon (Gen 2 #152-251, Gen 3 #252-386, Gen 4 #387-493) to drafts, free agency, trades and rookie classes, stays unlocked on the device for any later franchise, and can be entered at the start of a season. Your team comes along whole; titles show as Kanto, Johto, Hoenn and Sinnoh Champion banners on the hub. Win the Sinnoh championship and the next season returns to a drafted Kanto league, with your team, levels and unlocks kept and badges reset. The fourteen Hoenn Pokémon that were in the game before Hoenn (Sceptile, Blaziken, Swampert, Gardevoir, Mawile, Manectric, Milotic, Salamence, Metagross, the Lati twins, Kyogre, Groudon, Rayquaza) are always in the pool. The fifteen Sinnoh Pokémon that were in the game before Sinnoh (Infernape, Luxray, Bronzong, Garchomp, Lucario, Toxicroak, Weavile, Magnezone, Rhyperior, Tangrowth, Electivire, Togekiss, Leafeon, Mamoswine, Gallade) are always in the pool too.

### Gym drafts

Every region's eight gyms and final opponent follow the same rules (`src/franchise/kantoDraft.ts`). They change who a team drafts, never a rating.

- **Star lock.** Each of the nine locks a star before anyone picks. It always starts, even if you own that Pokémon too. No other team in the region can draft it. (The Indigo Elite's is Dragonite.)
- **Type first.** At each open position a team takes the best Pokémon of its types (a dual type counts if either matches; a final opponent's types are all its members'). It goes off type when the best Pokémon there is more than 4 OVR (`OFF_TYPE_MARGIN`) better than the best on-type one, and an on-type Pokémon rated under 82 (`ON_TYPE_FLOOR`) is never taken over a better rated one. A team still short of three on-type starters reaches past the margin for them, but not under 82. The final opponent drafts by the same rules. There are no per-team limits.
- **Thin types.** Some types can't fill three positions at 82 or better: Brock, Roxanne, Roark and Morty can start only their star on type (every Rock Pokémon rated 82 or better is a center, and Johto has no second Ghost at that rating), Bugsy can start as few as one, and Erika, Giovanni, Fantina, Jasmine, Pryce, Wattson, Gardenia, Candice and Volkner as few as two (`cpuDraft.test.ts` lists each).
- **No weak starters.** Apart from stars, every starter is rated 82 or better. Only eight non-legendary shooting guards in the game reach that, so when a team has none to take, a spare player from the closest position (usually a second point guard) starts there. That team gets no +2 lineup bonus, and carries nobody who would take the spot back.
- **Near equals.** Among picks within 1 OVR of each other (`NEAR_EQUAL`), each region's gyms take a different one (the final opponents take the best), and a team going off type leaves alone a Pokémon another team still needs for its theme. The draft has no randomness. With so few Pokémon rated 82 or better at SG, SF and PF, the same ones still start in every region.
- **Legendary cap.** Legendaries and mythicals (`RANKED_LEGENDARIES`) on the whole roster, star included: at most 1 for gyms 1-4, 2 for gyms 5-8 and 3 for the final opponent. Apart from its star, a team only takes a legendary of one of its types, to start or to sit.
- **Regional legendaries.** A region's teams only draft its own (`legendaries` in `regions.ts`), each on one team at most. Everything else comes from every region in the game, locked or not. Your own draft, free agents and trades are not affected.

| Region | Its legendaries |
| --- | --- |
| Kanto | Articuno, Zapdos, Moltres, Mewtwo, Mew (all five are gym stars) |
| Johto | Raikou, Entei, Suicune, Lugia, Ho-Oh, Celebi |
| Hoenn | Regirock, Regice, Registeel, Latias, Latios, Kyogre, Groudon, Rayquaza, Jirachi, Deoxys |
| Sinnoh | Uxie, Mesprit, Azelf, Heatran, Regigigas, Dialga, Palkia, Giratina, Cresselia, Manaphy, Darkrai, Shaymin, Arceus |

- **Order.** Teams pick one position at a time, final opponent first, then gym 8 down to gym 1, then the backups. On-type picks come before off-type ones. No team drafts a Pokémon on your team. An off-type backup is always rated below the starter at its position, so it never takes that spot.
- **Ramp.** Gym boosts are whole numbers from 0 to 4; a final opponent's goes up to 6 (Kanto, Johto and Sinnoh +6, Hoenn +5). Against a 91 OVR team, game strength never drops from badge to badge and the final opponent is at least 2 above gym 8:

| Region | Gyms 1-8 | Final |
| --- | --- | --- |
| Kanto | 86 88 89 90 90 91 92 93 | 95 |
| Johto | 87 88 89 89 90 90 91 92 | 97 |
| Hoenn | 86 87 88 89 89 90 91 92 | 98 |
| Sinnoh | 87 88 89 90 90 91 91 92 | 98 |

  Some neighbors tie because of the drafted cards: these are the fewest ties boosts of 0 to 4 allow with the final opponent 2 above gym 8 (only Kanto could avoid one, by leaving its Elite just 1 above). Other rosters change what the gyms can draft, and neighboring gyms can then swap; the final opponent stays at least 2 above gym 8 for the rosters in the tests.

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Move | WASD / arrows | Left stick / d-pad |
| Shoot, or jump to block | J / Space: hold, release when the meter is in the green | X |
| Dunk | Hold Shift and shoot near the rim | |
| Pass, or switch defender | K. Hold Shift while passing to a teammate near the rim for an alley-oop | A |
| Steal | L. Hold Shift to shove the ball handler (3s cooldown) | B |
| Turbo | Shift | Bumpers / triggers |
| Special move | I / E when the bar is full | Y |
| Pause | P / Esc | Start |

On phones the game shows a virtual stick and Xbox-style face buttons in the same colors and diamond layout: blue X to shoot, green A to pass, red B to steal, yellow Y for the special (it lights up when the bar is full), and RB for turbo. Landscape works best.

**Defense switching.** On defense you control one player at a time. With Defense switching on Auto (the default), every time the other team catches the ball you jump to the defender who should pick him up: his man-to-man matchup, or the nearest teammate still on his feet if that defender is out of the play. If you're already on the ball, you stay put. Pass/Switch still switches by hand anytime. Set it to Manual on the matchup or hub screen to only switch yourself.

### Systems

- **Difficulty.** Rookie and Pro are forgiving: a weaker CPU, a wider green window, defenders who bother your jumpers less, and a defensive assist (let go of the stick on defense and your player keeps guarding their man and boxes out). The CPU also eases off when it builds a big lead, like NBA Jam's catch-up. All-Star is an even game; Legend is for experts.
- **Matchups.** Each defender guards the opponent closest to their own position (the best pairing of all five), rebuilt after every substitution. Your player has a yellow P1 tag and a pulsing yellow ring so you can find them in a crowded paint.
- **Same odds as pokejam.xyz.** Shots, steals, blocks and rebounds roll the same odds as Quick Play and Franchise, and every roll comes from the match's seed, so a seed plus both players' inputs replays a game exactly (what the online winner check relies on).
- **Jump ball.** Each half opens with a tip-off between each team's best leaper. The ref tosses the ball and a meter fills as it rises: hit Shoot when it reaches the green band at the top of the toss. Timing counts most, then blocking, rebounding and size. CPU jumpers time it better on higher difficulties. Whoever loses a tip starts the next quarter with the ball (the 2nd after the opening tip, the 4th after the second-half tip). Overtime starts with a coin flip.
- **Shot meter.** Release timing sets the grade, from Excellent through Slightly Early/Late to Very Early/Late. An Excellent release is close to automatic unless the shot is heavily contested. The green window widens with the Shooting rating and when the shooter is on fire.
- **On fire.** Three straight baskets without the other team scoring sets a Pokémon on fire: unlimited turbo, a wider green window and longer dunk range.
- **Play of the Game.** After the final buzzer, the best moment replays before the results: a title card with the player and the play while the announcer introduces it ("Here's the play of the game!"), then a TV-style replay: the camera pushes in and follows the play (the ball once it's in the air), eases into deep slow motion, freezes for a beat on the moment with a flash and a punch-in, and eases back out (a little wider on phones, where the overlays cover more of a small court), and the popups and announcer calling it again. Any button skips it, and **Watch the play of the game** on the results screen plays it again ("Let's see that one again…"). Every offline game is recorded as inputs plus a snapshot every 2 seconds, and the replay is rebuilt from those and checked against the live game, so it's exactly what happened (`src/game/replay.ts`). The play favours your own team, and "GAME WINNER" means the winners' last lead change in the final 30 seconds.
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

Gen 1-3 ratings (#1-386) are generated: `node scripts/gen-pokemon-data.mjs` reads PokeAPI's open data (base stats, height, weight, evolution chains), maps it to basketball ratings calibrated against the hand-tuned cards, picks positions from the stat profile with a small nudge for body size (Pokémon with Speed under 45 never play guard; featherweights rarely play center), and writes `src/data/generated.ts` along with every Pokémon's real height and weight. On-court size (sprite scale, reach, rebounding and shove strength) is half real body size, half inside ratings, so Steelix and Onix tower over Pichu. Court designs live in `src/data/courts.ts`.

**Franchise regions** are data in `src/franchise/regions.ts`: a `RegionDef` with its unlock `index`, generation, inclusive `dex` range, `open` (dex numbers inside the range that were already in the game and stay in every pool), eight gyms in badge order and one `finale`. Every gym and finale names a `star`, unique within its region, and the region lists its own `legendaries`; the other nine spots are drafted by `kantoDraft.ts` (see [gym drafts](#gym-drafts)), so a region lists no rosters, and `boost` stays between 0 and 4 (up to 6 for a finale). A later region's CPU players still don't evolve past its generation. `cpuDraft.test.ts` checks the draft rules and each region's strength ramp; `regions.test.ts` and `laterRegions.test.ts` check the stars and the save rebuild. Bump `GYMS_REV` after changing stars, legendaries, boosts or the drafter, so saves rebuild. A new region is a new entry in `REGIONS`, a badge drawing per badge in `src/ui/badges.ts`, and, if its generation is new, `MAX_DEX` in the generator, a regenerated `generated.ts` and a `pokejam_mons` migration so the Social draft's server list matches. Unlocking, saves, the hub card and banners are generic.

Adding or hand-tuning a Pokémon is one row in `ROWS` in `src/data/pokemon.ts`; hand-tuned rows override generated ones. OVR, archetype, size and special move are derived from that row. Evolved forms go in `EVOLVED_ROWS`, with the level they're reached at in `EVOLUTIONS`.

Add `?speed=4` to the URL to run the simulation faster when testing.

## Saved for later

- **Legendary DLC:** Reshiram, Zekrom and Kyurem.
- **Multiplayer:** head-to-head and ranked Quick Play.

## Trailer

`trailer.html` + `src/trailer/trailer.ts` build an NBA Jam-style trailer from the real engine, shot on the Indigo Plateau court (Pallet Town vs the Elite Four). It opens on a real jump ball, then cuts between highlights found by scanning seeded CPU-vs-CPU games (dunks, blocks, a player catching fire, replayed with slow-motion punch-ins and callouts) and title scenes: the 291-Pokémon wall with Mewtwo at #1, the 60-second draft clock, Kyogre vs Groudon, the badge case and Elite Four crown, Dragonair evolving, and a $PJAM end card.

Three more cuts share the same engine, each with its own matchup, court and music:

- `vertical`: 9:16 for TikTok, Reels and Shorts. "POKéMON. BUT IT'S NBA JAM.", close-up gameplay, the card flip to Mewtwo, a buzzer beater, $PJAM.
- `franchise`: the season story. Brock's challenge, the 10-team draft board, the bench stepping in, Charmander's double evolution, badges, CHAMPIONS!, $PJAM.
- `top5`: a highlight-show countdown from #5 to #1 with lower-third captions.

```sh
npm run dev   # then open /trailer.html?play (or ?cut=vertical&play) for a real-time preview (no sound)
NODE_PATH=$(npm root -g) node scripts/render-trailer.mjs               # trailer-out/poke-jam-trailer.mp4
NODE_PATH=$(npm root -g) node scripts/render-trailer.mjs --cut top5    # trailer-out/top5/poke-jam-top5.mp4
```

Rendering needs Playwright with Chromium, ffmpeg (libx264 + aac) and python3 with numpy. `scripts/trailer-audio.py` composes the 128 BPM chiptune (D minor) and places sound effects on the cue times the engine reports.

---

Fan-made and not affiliated with Nintendo, Game Freak or The Pokémon Company. Pokémon names and sprites belong to their owners.
