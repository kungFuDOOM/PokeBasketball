# My Drafted Team (saved team format)

The Season Draft mode saves the ten Pokémon you drafted so other modes (and other clients on the same
origin) can start from them. It lives in `localStorage` on the device; nothing is sent anywhere.

- **Key:** `pokejam.draftedTeam`
- **Written:** when a Season Draft finishes. It is overwritten by the next one.
- **Removed by:** "Delete saved data" on the title screen (it removes every `pokejam.*` key).

## Format

JSON, versioned. Readers must check `v` and ignore (or discard) anything they don't understand.

```json
{
  "v": 1,
  "name": "Pallet Town",
  "abbr": "PAL",
  "colors": { "color": "#3b6fd8", "color2": "#16224a" },
  "dex": [150, 249, 25, 65, 94, 6, 448, 445, 149, 384],
  "starters": [0, 2, 3, 5, 7],
  "record": { "w": 12, "l": 6 },
  "rank": 2,
  "savedAt": 1767225600000
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `v` | `1` | Format version. |
| `name` | string | Team name, at most 20 characters, no control characters. |
| `abbr` | string, optional | Up to 4 letters, upper case. |
| `colors` | `{ color, color2 }` | Primary and secondary team color, `#rrggbb`. |
| `dex` | number[10] | National Pokédex numbers (Gen 1-5, 1-649), in draft order. Duplicates do not occur. |
| `starters` | number[5] | Distinct indices into `dex`: the starting five (best lineup by rating, covering PG-C where possible). The other five are the bench. |
| `record` | `{ w, l }`, optional | Regular-season record of the season it was drafted for. |
| `rank` | number, optional | League rank (1 = best) from that season. |
| `savedAt` | number | Milliseconds since the epoch. |

## Reading it safely

Storage can be edited by hand, so validate on read. The game does this in `src/season/team.ts`
(`loadDrafted`): it requires `v === 1`, exactly ten known dex numbers, five distinct starter indices in
0-9, valid hex colors and a non-empty plain-text name, and treats anything else as "no team".

## Where the game uses it

- **Quick Play:** "Your team: My Drafted Team" plays the five `starters` against a CPU-drafted opponent.
- **Franchise:** "Start with: My Drafted Team" gives your team all ten; the CPU teams draft from the rest.
