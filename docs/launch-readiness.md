# Online launch readiness (Social)

What has to be true before online play opens to the public, assuming some players will try to break it, cheat or harass others. Ranked and Pack Battles have their own gates (`docs/release-plan.md`, `docs/pack-battles-security-audit.md` on the prototype branch).

## Built (pokejam-test #15 and this PR)

| Threat | Defence |
|---|---|
| Stacking the game (a modified host picks the rosters or seed) | The server picks the seed and quarter length. Both clients derive both rosters from it and take names from the server. |
| Crashing or freezing the opponent's browser with crafted messages | `Lockstep.receive` validates every field. Billion-tick runs, out-of-window ticks, bad numbers and floods are dropped. A tampered snapshot, or a stream of resyncs, ends the game with no result. Pre-game buffers are capped. |
| Abusive names, impersonation, invisible characters | The server filter keeps a safe character set and blocks slurs (leetspeak, stretched letters) and staff or partner names. Innocent names are kept. Renames are limited. |
| Harassment | Report or block after any match. Blocked pairs are never matched again. Five different reporters in 24 hours give an automatic 24-hour suspension. Admin bans. |
| Spam and brute force | Rate limits on matchmaking, rooms, room-code tries (wrong ones count), renames, reports and TURN credentials. |
| Unlimited throwaway accounts | Turnstile bot check before a first anonymous sign-in (on when `VITE_TURNSTILE_SITE_KEY` is set), plus Supabase's own per-IP limit on anonymous sign-ins. |
| Bots playing online | A Cloudflare Turnstile check before quick match, making a room or joining one, verified on the server (`pokejam-human`, Siteverify) and good for a 20-minute pass. It's on once `require_human` is set. |
| Eavesdropping on or injecting into a match | Private match channels: RLS lets only the two players in, and only while the match is active. |
| Learning an opponent's IP address (to DDoS or dox them) | The direct link is relay-only through TURN: players never see each other's addresses. Without TURN there is no direct link at all. |
| A crash nobody reports | Crash reports from players' browsers (`src/telemetry/errors.ts`) go to `pokejam_errors`: one row per distinct error per day, with a count, capped at 2,000 a day and kept 30 days. Read them with `select * from pokejam_error_summary(1)` (service role). Set `VITE_BUILD_ID` on deploy to tell builds apart. |
| Filling the database with evidence | Only rated (and paid) matches sign and upload evidence; the server refuses Social uploads, and `pokejam_prune_evidence` deletes uploads after 30 days (daily, via pg_cron where it's on). |
| Burning the Realtime quota | Gameplay moves to the direct link (about 40 billed Realtime messages per game, down from about 35k). The fallback is paced at 10 a second, with hashes riding in the input batches. |
| A stale tab playing a new one | `NET_VERSION` is checked in the handshake. |
| A fake result from a test button | "Sim result (test)" exists only in dev builds. |

## For kungFuDOOM to set up (not done yet, as of 2026-10-24)

1. **Apply the online migrations**, in order: `20261025_pokejam_social_guard`, `20261026_pokejam_launch`, `20261027_pokejam_human_check`, `20261028_pokejam_match_evidence` and `20261029_pokejam_evidence_retention`, `20261030_pokejam_error_reports`, `20261031_pokejam_moderation` and `20261101_pokejam_social_draft` (#28), `20261102_pokejam_mons_sync`, then the launch fixes `20261103_pokejam_match_cleanup`, `20261104_pokejam_queue_heartbeat` and `20261105_pokejam_draft_presence` (apply these three before deploying the client that uses them; older clients keep working with them).
   - **Owner to confirm:** which of `20261106_pokejam_game_heartbeat` through `20261116_pokejam_admin_reports_reporter` are still unapplied. Apply any that are, in filename order, before the moderation migrations below (20261121 copies the 20261116 body of `pokejam_admin_reports`).
   - **Moderation: Dismiss and cheat-check tags.** Apply `20261121_pokejam_report_dismiss`, `20261122_pokejam_match_verdicts` and `20261123_pokejam_admin_reports_checks`, in that order, then deploy `pokejam-judge` (`supabase/functions/README.md`), and only then deploy the moderation page. Apply the migrations before the page deploy; the page tolerates an older server (without 20261123 it shows "No check" for everyone, and if `pokejam-judge` fails it still loads).
2. **Supabase plan:** go to Pro before a public launch, ideally with Poké Jam in **its own project**. On Free, 100 Realtime messages a second project-wide carry only about 2 fallback games at once, and 200 peak connections cap play at about 100 matches. Quotas are per organization, shared with gauntlet-legends. Keep the spend cap on at first.
3. **Supabase Auth:** turn on anonymous sign-ins, and keep the per-IP anonymous sign-in limit at or below the default. Optionally add the Turnstile secret under Bot and Abuse Protection, for the check at first sign-in.
4. **Supabase Realtime:** turn off "Allow public access" once nothing on the project needs public channels (check gauntlet-legends first). Otherwise anyone with the public key can broadcast on any public topic and burn the shared quota.
5. **Cloudflare TURN:** create a TURN key, set `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` and `ICE_ALLOWED_ORIGINS`, and deploy `pokejam-ice` (`supabase/functions/README.md`). Without it, every game falls back to Realtime and the limits above bite.
6. **Cloudflare Turnstile (#20):** create the widget and put its site key in Vercel as `VITE_TURNSTILE_SITE_KEY`. Set `TURNSTILE_SECRET_KEY` and `HUMAN_ALLOWED_ORIGINS`, deploy `pokejam-human`, then turn on `require_human` (`supabase/functions/README.md`).
   - **If players see "bot check failed":** the message says which step refused. "Cloudflare's bot check failed (error 110200…)" means the site's hostname isn't on the widget's list in Cloudflare. "The server refused the bot check (…)" comes from `pokejam-human`: "unreachable" means it isn't deployed or the site isn't in `HUMAN_ALLOWED_ORIGINS`, and "403 check failed" means `TURNSTILE_SECRET_KEY` isn't the secret of the widget whose site key is in Vercel. To unblock testing meanwhile: `update public.pokejam_config set value = 'false' where key = 'require_human';`.
7. **Vercel env on pokejam-test:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the publishable key) and `VITE_MODE_SOCIAL=true`.
8. **Then thepaypay420 checks it live:** reruns `scripts/e2e-social.mjs` against the real project (`E2E_CREDS` test accounts if Turnstile is on). That's the first live check of TURN, private channels and Turnstile. Then a load test of many concurrent matches.
9. **Testers get access**, and kungFuDOOM plays it and says **"Merge" for Social** on pokejam.xyz.
10. **Moderation during launch:** the moderation page (`admin.html`, migration `20261031_pokejam_moderation.sql`) lists reported players, suspensions (automatic ones included) and every moderator action. Check it daily, and watch Realtime Reports (messages and peak connections) and the fallback rate. To set it up:
    - turn on email sign-in (magic link) in Supabase Auth;
    - add `…/admin.html` to Auth → URL Configuration → Redirect URLs;
    - invite the moderator's email (Auth → Users), then `insert into public.pokejam_admins(user_id, note) select id, 'kungFuDOOM' from auth.users where email = '…';`

Later stages, which are owner calls:
- counsel on which states can play Pack Battles;
- mainnet, the 8% fee and run-it-back;
- Collector Crypt's mainnet gacha wallet (`CC_SIGNER`) and an API key or partnership;
- the ElevenLabs licence for commercial use of the announcer.

## Numbers (from Supabase's and Cloudflare's docs, October 2026)

| | Free | Pro |
|---|---|---|
| Realtime messages per month | 2M | 5M, then $2.50 per million |
| Realtime messages per second | 100 | 500 |
| Peak connections | 200 | 500 |

- **Billing:** each broadcast counts once sent plus once per receiver.
- **Before this change:** about 64 billed messages a second per game, and about 35k per game with 2-minute quarters.
- **Direct link:** about 40 per game.
- **Fallback:** about 40 a second, and about 22k per game.
- **Cloudflare TURN:** $0.05/GB after 1,000 GB a month (shared with their SFU). A game is a few MB.

## Still open

- **Ranked results** can be gamed: a loser can void by disputing, or a losing host can simply never report. Ranked must judge from signed inputs (`winnerCheck.ts`) or replay before it ships, and it needs its own smurfing controls.
- **Bots and macros** in Social aren't detected. That's acceptable with no stakes; Pack Battles already has its own audit item.
- **The name filter is a list.** Determined trolls will find gaps, so reports and bans are the backstop. Swap in a maintained list if one is chosen.
- **No error monitoring yet** (Sentry or similar), so a launch-day crash would only be seen through player reports.
