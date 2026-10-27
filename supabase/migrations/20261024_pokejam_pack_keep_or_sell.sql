-- Pack Battles: keep it or sell it back, at the reveal (docs/pack-battles-design.md). Shared gauntlet-legends
-- project: only pokejam_* objects. Runs after 20261023_pokejam_pack_payouts.sql.
--
-- Once the pull is open, the house holds the card and the prize waits as 'revealed' while the winner sees it
-- with two buttons: Keep it (the card goes to their wallet) or Sell it back (CC's instant buyback, to their
-- balance). Their pick, or their saved preference (prefer_cash) once choose_by passes, settles it. CC's
-- buyback window is 72 hours, so the wait costs nothing.
--
--   pending -> sending -> revealed -> sending -> sent | cashed
--
-- pokejam_pack_choose_prize is the one prize write a player makes; RLS stays read-only for them.

-- ---------- columns and states ----------

alter table public.pokejam_pack_prizes
  add column if not exists choice text check (choice in ('keep', 'sell')),
  add column if not exists choose_by timestamptz,
  add column if not exists sell_estimate bigint check (sell_estimate > 0);

alter table public.pokejam_pack_prizes drop constraint if exists pokejam_pack_prizes_state_check;
alter table public.pokejam_pack_prizes add constraint pokejam_pack_prizes_state_check
  check (state in ('pending', 'sending', 'revealed', 'sent', 'cashed', 'refunded', 'failed'));

-- ---------- service-role functions (Edge Functions only) ----------

-- Claim due prizes as before, plus revealed cards whose winner has chosen or whose time is up. A revealed card
-- moves to 'sending' here, so a pick that arrives after the claim finds nothing to change (and says so).
create or replace function public.pokejam_pack_claim_prizes(p_limit int, p_max_attempts int)
returns setof public.pokejam_pack_prizes language sql security definer set search_path = public as $$
  with due as (
    select id from public.pokejam_pack_prizes
    where ((state = 'pending' or (state = 'failed' and attempts < p_max_attempts)) and next_try_at <= now())
       or (state = 'revealed' and (choice is not null or choose_by <= now()))
    order by created_at
    limit greatest(1, least(coalesce(p_limit, 10), 50))
    for update skip locked
  )
  update public.pokejam_pack_prizes p set state = 'sending', updated_at = now()
  from due where p.id = due.id
  returning p.*;
$$;

-- The card is open and in the house wallet: show it to the winner and wait up to p_wait_seconds for their
-- pick. A deadline that's already set is kept (a prize claimed again after a crash doesn't get more time).
-- pokejam_pack_recover_prizes only touches 'sending', so a waiting card stays waiting through a restart.
create or replace function public.pokejam_pack_prize_revealed(p_id uuid, p_wait_seconds int, p_sell_estimate bigint)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_prizes set state = 'revealed',
    choose_by = coalesce(choose_by, now() + make_interval(secs => greatest(0, least(p_wait_seconds, 86400)))),
    sell_estimate = coalesce(sell_estimate, nullif(greatest(p_sell_estimate, 0), 0)),
    last_error = null, updated_at = now()
  where id = p_id and state = 'sending';
$$;

-- ---------- player RPC ----------

-- The winner's pick on a revealed card: 'keep' or 'sell'. True when it's taken. False when the prize isn't
-- theirs, or isn't waiting any more (already on its way, or not opened yet): read the prize row to see which.
-- They can change their mind until the worker picks it up (at most a minute with the every-minute cron).
create or replace function public.pokejam_pack_choose_prize(p_id uuid, p_choice text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'sign in to choose'; end if;
  if p_choice is null or p_choice not in ('keep', 'sell') then raise exception 'choice must be keep or sell'; end if;
  update public.pokejam_pack_prizes set choice = p_choice, updated_at = now()
    where id = p_id and user_id = auth.uid() and state = 'revealed';
  get diagnostics n = row_count;
  return n = 1;
end $$;

revoke all on function public.pokejam_pack_prize_revealed(uuid, int, bigint), public.pokejam_pack_choose_prize(uuid, text)
  from public, anon, authenticated;
grant execute on function public.pokejam_pack_prize_revealed(uuid, int, bigint) to service_role;
grant execute on function public.pokejam_pack_choose_prize(uuid, text) to authenticated;
