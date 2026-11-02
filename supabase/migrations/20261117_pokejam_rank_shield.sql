-- PokeJam Ranked, Rank Shield (PR A, core): a collectable item that saves the points of one lost ranked match, earned
-- free from a weekly challenge. Shared gauntlet-legends project: pokejam_* only. Additive and safe to run again; nothing
-- is dropped. NET_VERSION and the netcode are untouched. Buying shields (Stripe, PR B) only adds RPCs and Edge Functions
-- on top of the tables created here.
--
-- Rules (owner decisions):
--  - Earn: at most 1 free shield per ISO week (UTC) from the weekly challenge (default "play 10 ranked games"; a row in
--    pokejam_weekly_challenge switches the kind for a week: 'games', 'wins' or 'days').
--  - Use: at most 1 per ROLLING 24 h, checked when arming (friendly error) and again when scoring, under the player's
--    profile lock, as one conditional update (pokejam_shield_consume), so nothing can double-spend.
--  - Hold at most 14. Purchases are capped at 42 per season (pokejam_shield_purchases; PR B writes it).
--  - The shield is armed (a toggle) before a match. It is locked once the match is paired: there is no arm/disarm while a
--    ranked match is active, and an arm made after the pairing can't exist. It is consumed ONLY when a normal 'score' loss
--    would cost points. Never on a win, leave, forfeit, dodge, void, placements, Zenith, or Bronze 3 with 0 points.
--  - The automatic 0-point guard ("Demotion Guard" in the UI, shield_charge) runs first inside pokejam_ranked_step. When it
--    fires the item is not consumed. A shielded loss still counts in W/L and the streak, and does not advance
--    losses_since_shield.
--  - The arm is cleared when the match is scored (any outcome, both players), by a lazy check for a match that was voided
--    without scoring (pokejam_shield_arm_state), and at season rollover.
--
-- pokejam_ranked_player_update keeps its signature, so the match id reaches it through a transaction-local setting
-- ('pokejam.shield_match') that pokejam_ranked_apply sets around the two updates. Without it nothing is shielded.
--
-- Clients get SELECT on their own rows only; every write goes through SECURITY DEFINER functions.

-- ---------- tables ----------
create table if not exists public.pokejam_shield_inventory (
  user_id uuid primary key references public.pokejam_profiles(id) on delete cascade,
  count int not null default 0 check (count between 0 and 14),
  last_used_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Append-only audit trail; the inventory is a cache that can be rebuilt from it. A weekly grant lost to the hold cap is
-- recorded with delta 0, so the week stays claimed.
create table if not exists public.pokejam_shield_ledger (
  id bigserial primary key,
  user_id uuid not null references public.pokejam_profiles(id) on delete cascade,
  delta int not null,
  reason text not null check (reason in ('purchase','weekly','use','refund','clawback','admin')),
  ref text not null,
  match_id uuid,
  created_at timestamptz not null default now(),
  unique (user_id, reason, ref)
);
create index if not exists pokejam_shield_ledger_user on public.pokejam_shield_ledger(user_id, created_at desc);

-- At most one row per player: "armed for my next ranked match".
create table if not exists public.pokejam_shield_armed (
  user_id uuid primary key references public.pokejam_profiles(id) on delete cascade,
  armed_at timestamptz not null default now()
);

create table if not exists public.pokejam_shield_products (
  sku text primary key,
  stripe_price_id text,
  units int not null check (units between 1 and 14),
  price_cents int not null check (price_cents > 0),
  active boolean not null default false
);
insert into public.pokejam_shield_products(sku, units, price_cents, active) values
  ('shield_3', 3, 199, false), ('shield_7', 7, 399, false), ('shield_14', 14, 699, false)
  on conflict (sku) do nothing;

create table if not exists public.pokejam_shield_purchases (
  session_id text primary key,
  user_id uuid not null references public.pokejam_profiles(id) on delete cascade,
  sku text not null,
  units int not null,
  payment_intent text unique,
  amount_cents int,
  status text not null default 'paid' check (status in ('paid','refunded','disputed')),
  clawback_short int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists pokejam_shield_purchases_user on public.pokejam_shield_purchases(user_id, created_at desc);

-- Stripe webhook idempotency (PR B). No client access at all.
create table if not exists public.pokejam_stripe_events (
  event_id text primary key,
  type text,
  received_at timestamptz not null default now()
);

-- One row per week that deviates from the default (games, 10).
create table if not exists public.pokejam_weekly_challenge (
  week_start date primary key,
  kind text not null default 'games' check (kind in ('games','wins','days')),
  goal int not null default 10 check (goal between 1 and 50)
);

create table if not exists public.pokejam_weekly_progress (
  user_id uuid not null references public.pokejam_profiles(id) on delete cascade,
  week_start date not null,
  progress int not null default 0,
  days date[] not null default '{}',
  completed_at timestamptz,
  primary key (user_id, week_start)
);

alter table public.pokejam_ranked_matches add column if not exists host_shield_saved int;
alter table public.pokejam_ranked_matches add column if not exists guest_shield_saved int;

alter table public.pokejam_shield_inventory enable row level security;
alter table public.pokejam_shield_ledger enable row level security;
alter table public.pokejam_shield_armed enable row level security;
alter table public.pokejam_shield_products enable row level security;
alter table public.pokejam_shield_purchases enable row level security;
alter table public.pokejam_stripe_events enable row level security;
alter table public.pokejam_weekly_challenge enable row level security;
alter table public.pokejam_weekly_progress enable row level security;

revoke all on public.pokejam_shield_inventory, public.pokejam_shield_ledger, public.pokejam_shield_armed,
  public.pokejam_shield_products, public.pokejam_shield_purchases, public.pokejam_stripe_events,
  public.pokejam_weekly_challenge, public.pokejam_weekly_progress from anon, authenticated, public;
revoke all on sequence public.pokejam_shield_ledger_id_seq from anon, authenticated, public;
grant select on public.pokejam_shield_inventory, public.pokejam_shield_ledger, public.pokejam_shield_armed,
  public.pokejam_shield_products, public.pokejam_shield_purchases, public.pokejam_weekly_challenge,
  public.pokejam_weekly_progress to authenticated;

drop policy if exists "pokejam own shield inventory" on public.pokejam_shield_inventory;
create policy "pokejam own shield inventory" on public.pokejam_shield_inventory for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "pokejam own shield ledger" on public.pokejam_shield_ledger;
create policy "pokejam own shield ledger" on public.pokejam_shield_ledger for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "pokejam own shield armed" on public.pokejam_shield_armed;
create policy "pokejam own shield armed" on public.pokejam_shield_armed for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "pokejam own shield purchases" on public.pokejam_shield_purchases;
create policy "pokejam own shield purchases" on public.pokejam_shield_purchases for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "pokejam own weekly progress" on public.pokejam_weekly_progress;
create policy "pokejam own weekly progress" on public.pokejam_weekly_progress for select to authenticated using (user_id = (select auth.uid()));
-- Shop and challenge config: the same for everybody. Inactive products stay hidden.
drop policy if exists "pokejam shield products readable" on public.pokejam_shield_products;
create policy "pokejam shield products readable" on public.pokejam_shield_products for select to authenticated using (active);
drop policy if exists "pokejam weekly challenge readable" on public.pokejam_weekly_challenge;
create policy "pokejam weekly challenge readable" on public.pokejam_weekly_challenge for select to authenticated using (true);

-- ---------- weekly challenge ----------
-- Monday 00:00 UTC of the current ISO week.
create or replace function public.pokejam_weekly_start()
returns date language sql stable as $$ select (date_trunc('week', now() at time zone 'UTC'))::date $$;

create or replace function public.pokejam_weekly_cfg(p_week date, out o_kind text, out o_goal int)
language plpgsql stable security definer set search_path = public as $$
begin
  select c.kind, c.goal into o_kind, o_goal from public.pokejam_weekly_challenge c where c.week_start = p_week;
  if o_kind is null then o_kind := 'games'; o_goal := 10; end if;
end $$;

-- Gives one shield for a completed week. The unique (user, 'weekly', week) ledger row makes a second grant impossible; a
-- grant above the hold cap of 14 is lost (recorded with delta 0).
create or replace function public.pokejam_shield_grant_weekly(p_user uuid, p_week date)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_count int; v_delta int; v_id bigint;
begin
  insert into public.pokejam_shield_inventory(user_id) values (p_user) on conflict (user_id) do nothing;
  select count into v_count from public.pokejam_shield_inventory where user_id = p_user for update;
  v_delta := case when v_count < 14 then 1 else 0 end;
  insert into public.pokejam_shield_ledger(user_id, delta, reason, ref) values (p_user, v_delta, 'weekly', p_week::text)
    on conflict (user_id, reason, ref) do nothing returning id into v_id;
  if v_id is null then return false; end if;
  if v_delta > 0 then
    update public.pokejam_shield_inventory set count = count + 1, updated_at = now() where user_id = p_user;
  end if;
  return v_delta > 0;
end $$;

-- Counts one scored ranked match toward this week's challenge (called by pokejam_ranked_apply after the match row is
-- stored, so that row is included in the pair count). The 4th and later scored game against one opponent in a week
-- doesn't count. Completing the goal grants the weekly shield once.
create or replace function public.pokejam_weekly_progress(p_user uuid, p_match uuid, p_won boolean)
returns void language plpgsql security definer set search_path = public as $$
declare w date := public.pokejam_weekly_start(); v_kind text; v_goal int; m public.pokejam_matches; opp uuid; n int;
        wp public.pokejam_weekly_progress; v_days date[]; v_prog int; today date := (now() at time zone 'UTC')::date;
begin
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or p_user not in (m.host, m.guest) then return; end if;
  opp := case when p_user = m.host then m.guest else m.host end;
  select count(*)::int into n from public.pokejam_ranked_matches r
    where r.reason = 'score' and r.created_at >= (w::timestamp at time zone 'UTC')
      and ((r.host_id = p_user and r.guest_id = opp) or (r.host_id = opp and r.guest_id = p_user));
  if n > 3 then return; end if;
  select o_kind, o_goal into v_kind, v_goal from public.pokejam_weekly_cfg(w);
  insert into public.pokejam_weekly_progress(user_id, week_start) values (p_user, w) on conflict do nothing;
  select * into wp from public.pokejam_weekly_progress where user_id = p_user and week_start = w for update;
  if wp.completed_at is not null then return; end if;
  v_days := wp.days;
  if v_kind = 'days' and not (today = any(v_days)) then v_days := v_days || today; end if;
  v_prog := case v_kind when 'games' then wp.progress + 1 when 'wins' then wp.progress + (case when p_won then 1 else 0 end)
    else cardinality(v_days) end;
  update public.pokejam_weekly_progress set progress = v_prog, days = v_days,
    completed_at = case when v_prog >= v_goal then now() end where user_id = p_user and week_start = w;
  if v_prog >= v_goal then perform public.pokejam_shield_grant_weekly(p_user, w); end if;
end $$;

-- ---------- arm state ----------
-- {armed, locked} for a player. The arm belongs to the first ranked match paired after it was made: while that match is
-- active the arm is locked; if it ended without being scored (voided) the arm is stale and removed here.
create or replace function public.pokejam_shield_arm_state(p_user uuid, out o_armed boolean, out o_locked boolean)
language plpgsql security definer set search_path = public as $$
declare a timestamptz; m record;
begin
  o_armed := false; o_locked := false;
  select armed_at into a from public.pokejam_shield_armed where user_id = p_user;
  select x.status, x.created_at into m from public.pokejam_matches x
    where x.queue = 'ranked' and x.guest is not null and p_user in (x.host, x.guest) and x.created_at >= coalesce(a, '-infinity')
    order by x.created_at desc limit 1;
  -- Locked while a ranked match is on, armed or not (nobody can arm after seeing who they got).
  o_locked := m.created_at is not null and m.status = 'active' and m.created_at > now() - interval '2 hours';
  if a is null then return; end if;
  if m.created_at is null or o_locked then o_armed := true; return; end if;
  delete from public.pokejam_shield_armed where user_id = p_user;
end $$;

-- Why a player can't arm right now: null (they can), 'empty', 'used_today', 'placing', 'zenith' or 'nothing_to_lose'.
create or replace function public.pokejam_shield_block(p_user uuid)
returns text language plpgsql security definer set search_path = public as $$
declare inv public.pokejam_shield_inventory; s public.pokejam_seasons; p public.pokejam_ranked_profiles;
begin
  select * into inv from public.pokejam_shield_inventory where user_id = p_user;
  if inv.user_id is null or inv.count <= 0 then return 'empty'; end if;
  if inv.last_used_at is not null and inv.last_used_at > now() - interval '24 hours' then return 'used_today'; end if;
  s := public.pokejam_ranked_season();
  select * into p from public.pokejam_ranked_profiles where user_id = p_user and season_id = s.id;
  if p.user_id is null or p.status = 'placing' then return 'placing'; end if;
  if p.div_idx >= 24 then return 'zenith'; end if;
  if p.div_idx = 0 and p.points = 0 then return 'nothing_to_lose'; end if;
  return null;
end $$;

-- Everything the UI shows about the item and the weekly challenge. Internal; used by the two RPCs below and ranked_me.
create or replace function public.pokejam_shield_status(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.pokejam_shield_inventory; st record; w date := public.pokejam_weekly_start(); v_kind text; v_goal int;
        wp public.pokejam_weekly_progress; s public.pokejam_seasons; v_bought int; v_next timestamptz;
begin
  select * into inv from public.pokejam_shield_inventory where user_id = p_user;
  select * into st from public.pokejam_shield_arm_state(p_user);
  select o_kind, o_goal into v_kind, v_goal from public.pokejam_weekly_cfg(w);
  select * into wp from public.pokejam_weekly_progress where user_id = p_user and week_start = w;
  s := public.pokejam_ranked_season();
  select coalesce(sum(units), 0)::int into v_bought from public.pokejam_shield_purchases
    where user_id = p_user and status = 'paid' and created_at >= s.starts_at;
  v_next := case when inv.last_used_at > now() - interval '24 hours' then inv.last_used_at + interval '24 hours' end;
  return jsonb_build_object('count', coalesce(inv.count, 0), 'cap', 14, 'armed', st.o_armed, 'locked', st.o_locked,
    'next_use_at', v_next, 'arm_block', public.pokejam_shield_block(p_user), 'purchases_left', greatest(0, 42 - v_bought),
    'weekly', jsonb_build_object('kind', v_kind, 'goal', v_goal, 'progress', least(coalesce(wp.progress, 0), v_goal),
      'done', wp.completed_at is not null, 'week_start', w, 'resets_at', ((w + 7)::timestamp at time zone 'UTC')));
end $$;

create or replace function public.pokejam_shield_me()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return public.pokejam_shield_status(auth.uid());
end $$;

-- Arm or disarm for the next ranked match. Refused: not a member, locked (a match is on), no shield, used in the last
-- 24 h, placing, Zenith, nothing to lose. Returns the new status.
create or replace function public.pokejam_shield_arm(p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); st record; v_block text;
begin
  if me is null then raise exception 'not signed in'; end if;
  perform public.pokejam_ranked_require_member();
  select * into st from public.pokejam_shield_arm_state(me);
  if st.o_locked then raise exception 'Rank Shield is locked for this match'; end if;
  if p_on then
    v_block := public.pokejam_shield_block(me);
    if v_block is not null then
      raise exception '%', case v_block
        when 'empty' then 'You have no Rank Shield'
        when 'used_today' then 'Rank Shield used in the last 24 hours'
        when 'placing' then 'Placement games can''t be shielded'
        when 'zenith' then 'Rank Shield doesn''t work in Zenith'
        else 'Nothing to lose' end;
    end if;
    insert into public.pokejam_shield_armed(user_id) values (me) on conflict (user_id) do nothing;
  else
    delete from public.pokejam_shield_armed where user_id = me;
  end if;
  return public.pokejam_shield_status(me);
end $$;

-- Spends one shield for a lost match, only if the player holds one and none was used in the last 24 h. A single
-- conditional update: the profile lock held by the caller plus the row lock here make a double spend impossible.
-- Returns whether a shield was spent. Internal.
create or replace function public.pokejam_shield_consume(p_user uuid, p_match uuid, p_saved int)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.pokejam_shield_inventory set count = count - 1, last_used_at = now(), updated_at = now()
    where user_id = p_user and count > 0 and (last_used_at is null or last_used_at <= now() - interval '24 hours');
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  insert into public.pokejam_shield_ledger(user_id, delta, reason, ref, match_id) values (p_user, -1, 'use', p_match::text, p_match)
    on conflict (user_id, reason, ref) do nothing;
  return true;
end $$;

-- ---------- scoring ----------
-- As 20261111, plus: for an armed player, a normal 'score' loss that would cost points costs nothing and spends the
-- shield (unless the Demotion Guard fired). The result gains {shield: {armed, used, saved}} only when an arm applied.
create or replace function public.pokejam_ranked_player_update(p_user uuid, p_season int, p_won boolean, p_mode text,
  p_diff int, p_total int, p_opp_idx int, p_opp_score int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.pokejam_ranked_profiles; st record; v_before int; v_after int; v_pts int; v_heavy boolean := false;
        v_leaves int; v_wstart timestamptz; v_cool int := 0; v_flag boolean; v_w numeric; v_raw numeric; v_played int;
        v_shift int; v_start int; v_event text := null; v_streak int; v_div int; v_new_points int;
        o_div int; o_pts int; o_charge int; o_lsh int; o_delta int; o_event text;
        v_match uuid := nullif(current_setting('pokejam.shield_match', true), '')::uuid;
        v_armed boolean := false; v_used boolean := false; v_saved int := 0; v_res jsonb;
begin
  select * into p from public.pokejam_ranked_profiles where user_id = p_user and season_id = p_season for update;
  v_leaves := p.leaves_24h; v_wstart := p.leave_window_start; v_flag := p.leaver_flagged;
  if p_mode = 'leave' then
    if v_wstart is null or now() - v_wstart > interval '24 hours' then v_leaves := 0; v_wstart := now(); end if;
    v_leaves := v_leaves + 1;
    v_heavy := v_leaves >= 3;
    v_cool := case when v_leaves >= 4 then 60 when v_leaves = 3 then 15 when v_leaves = 2 then 5 else 0 end;
    v_flag := v_flag or v_leaves >= 4;
  end if;
  v_streak := case when p_mode = 'stay' then p.streak when p_won then greatest(p.streak, 0) + 1 else least(p.streak, 0) - 1 end;

  if p.status = 'placing' then
    v_w := public.pokejam_ranked_placement_weight(p_mode, p_diff, p_total, p_opp_score, p.seed_score);
    v_raw := p.placement_raw + case when p_won then v_w else -v_w end;
    v_played := p.placements_played + 1;
    v_before := p.seed_score;
    if v_played >= 5 then
      v_shift := public.pokejam_ranked_placement_shift(v_raw);
      v_start := greatest(0, least(2299, p.seed_score + v_shift));
      update public.pokejam_ranked_profiles set status = 'ranked', placement_raw = v_raw, placements_played = v_played,
        div_idx = v_start / 100, points = v_start % 100, peak_idx = v_start / 100, shield_charge = 1, losses_since_shield = 0
        where user_id = p_user and season_id = p_season;
      v_event := 'placed'; v_after := v_start;
    else
      update public.pokejam_ranked_profiles set placement_raw = v_raw, placements_played = v_played
        where user_id = p_user and season_id = p_season;
      v_after := v_before;
    end if;
    update public.pokejam_ranked_profiles set wins = wins + (case when p_won then 1 else 0 end),
      losses = losses + (case when p_won then 0 else 1 end), streak = v_streak, leaves_24h = v_leaves,
      leave_window_start = v_wstart, leaver_flagged = v_flag,
      cooldown_until = case when v_cool > 0 then now() + make_interval(mins => v_cool) else cooldown_until end,
      last_game_at = now(), updated_at = now() where user_id = p_user and season_id = p_season;
    select * into p from public.pokejam_ranked_profiles where user_id = p_user and season_id = p_season;
    return jsonb_build_object('placing', true, 'event', v_event, 'placements_played', p.placements_played,
      'before', v_before, 'after', v_after, 'delta', case when v_event = 'placed' then v_shift else null end,
      'div_idx', p.div_idx, 'points', p.points);
  end if;

  v_pts := p.points;
  if p.div_idx = 24 and p.last_game_at is not null then
    v_pts := public.pokejam_ranked_zenith_decay(p.points, floor(extract(epoch from (now() - p.last_game_at)) / 86400)::int);
  end if;
  v_before := public.pokejam_ranked_ladder(p.div_idx, v_pts);
  select * into st from public.pokejam_ranked_step(p.div_idx, v_pts, p.shield_charge, p.losses_since_shield, p_won,
    p_diff, p_total, p_opp_idx, p_mode, v_heavy);
  o_div := st.o_div; o_pts := st.o_pts; o_charge := st.o_charge; o_lsh := st.o_lsh; o_delta := st.o_delta; o_event := st.o_event;
  -- Rank Shield: only an arm made before this match was paired counts.
  if v_match is not null then
    v_armed := exists (select 1 from public.pokejam_shield_armed a join public.pokejam_matches mm on mm.id = v_match
                       where a.user_id = p_user and a.armed_at <= mm.created_at);
  end if;
  -- The Demotion Guard ('shielded') ran first inside the step; then the item is not spent. Zenith has no item.
  if v_armed and p_mode = 'score' and not p_won and p.div_idx < 24 and o_event is distinct from 'shielded' then
    v_saved := v_before - public.pokejam_ranked_ladder(o_div, o_pts);
    if v_saved > 0 and public.pokejam_shield_consume(p_user, v_match, v_saved) then
      v_used := true;
      o_div := p.div_idx; o_pts := v_pts; o_charge := p.shield_charge; o_lsh := p.losses_since_shield; o_delta := 0; o_event := null;
    else
      v_saved := 0;
    end if;
  end if;
  v_after := public.pokejam_ranked_ladder(o_div, o_pts);
  update public.pokejam_ranked_profiles set div_idx = o_div, points = o_pts, shield_charge = o_charge,
    losses_since_shield = o_lsh, wins = wins + (case when p_won then 1 else 0 end),
    losses = losses + (case when p_won then 0 else 1 end), streak = v_streak, peak_idx = greatest(peak_idx, o_div),
    leaves_24h = v_leaves, leave_window_start = v_wstart, leaver_flagged = v_flag,
    cooldown_until = case when v_cool > 0 then now() + make_interval(mins => v_cool) else cooldown_until end,
    last_game_at = now(), updated_at = now() where user_id = p_user and season_id = p_season;
  v_res := jsonb_build_object('placing', false, 'event', o_event, 'placements_played', 5, 'before', v_before,
    'after', v_after, 'delta', o_delta, 'div_idx', o_div, 'points', o_pts);
  if v_armed then
    v_res := v_res || jsonb_build_object('shield', jsonb_build_object('armed', true, 'used', v_used, 'saved', v_saved));
  end if;
  return v_res;
end $$;

-- As 20261111, plus: the match id is handed to pokejam_ranked_player_update for the Rank Shield, the saved points are
-- stored on the match row, both players' arms are cleared (every outcome, including a dodge), and each scored human
-- counts toward the weekly challenge (reason 'score' only: a leave, forfeit or dodge never counts).
create or replace function public.pokejam_ranked_apply(p_match uuid, p_reason text default 'score',
  p_leaver uuid default null, p_dodge boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.pokejam_matches; s public.pokejam_seasons; v_prev jsonb; hp public.pokejam_ranked_profiles; gp public.pokejam_ranked_profiles;
        a uuid; b uuid; v_winner uuid; v_wscore int; v_lscore int; v_diff int := 0; v_total int := 1; v_known boolean := false;
        hs int; gs int; hres jsonb; gres jsonb; h_opp_idx int; g_opp_idx int; h_opp int; g_opp int; v_res jsonb;
begin
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null or m.queue <> 'ranked' or m.guest is null then raise exception 'not a ranked match'; end if;
  select result into v_prev from public.pokejam_ranked_matches where match_id = p_match;
  if v_prev is not null then return v_prev; end if;
  if p_reason not in ('score','leave','forfeit') then raise exception 'bad reason'; end if;
  if p_reason <> 'score' and (p_leaver is null or p_leaver not in (m.host, m.guest)) then raise exception 'bad leaver'; end if;
  s := public.pokejam_ranked_season();
  -- lock both profiles in a fixed order
  a := least(m.host, m.guest); b := greatest(m.host, m.guest);
  perform public.pokejam_ranked_profile_lock(a, s.id);
  perform public.pokejam_ranked_profile_lock(b, s.id);
  select * into hp from public.pokejam_ranked_profiles where user_id = m.host and season_id = s.id;
  select * into gp from public.pokejam_ranked_profiles where user_id = m.guest and season_id = s.id;
  -- an opponent's division as the adj input and their ladder score for placement weights (their seed while placing)
  h_opp_idx := case when gp.status = 'placing' then least(23, gp.seed_score / 100) else gp.div_idx end;
  g_opp_idx := case when hp.status = 'placing' then least(23, hp.seed_score / 100) else hp.div_idx end;
  h_opp := case when gp.status = 'placing' then gp.seed_score else public.pokejam_ranked_ladder(gp.div_idx, gp.points) end;
  g_opp := case when hp.status = 'placing' then hp.seed_score else public.pokejam_ranked_ladder(hp.div_idx, hp.points) end;
  perform set_config('pokejam.shield_match', p_match::text, true);

  if p_reason = 'score' then
    v_winner := m.winner;
    if v_winner is null then raise exception 'match has no winner'; end if;
    select x.host_score, x.guest_score into hs, gs
      from public.pokejam_ranked_scores x join public.pokejam_ranked_scores y
        on y.match_id = x.match_id and y.user_id = m.guest and y.host_score = x.host_score and y.guest_score = x.guest_score
      where x.match_id = p_match and x.user_id = m.host;
    if hs is not null and hs <= 300 and gs <= 300 then
      v_wscore := case when v_winner = m.host then hs else gs end;
      v_lscore := case when v_winner = m.host then gs else hs end;
      if v_wscore > v_lscore then v_diff := v_wscore - v_lscore; v_total := v_wscore + v_lscore; v_known := true; end if;
    end if;
    hres := public.pokejam_ranked_player_update(m.host, s.id, v_winner = m.host, 'score', v_diff, v_total, h_opp_idx, h_opp);
    gres := public.pokejam_ranked_player_update(m.guest, s.id, v_winner = m.guest, 'score', v_diff, v_total, g_opp_idx, g_opp);
  else
    v_winner := case when p_dodge then null when p_leaver = m.host then m.guest else m.host end;
    if p_leaver = m.host then
      hres := public.pokejam_ranked_player_update(m.host, s.id, false, 'leave', 0, 1, h_opp_idx, h_opp);
      if not p_dodge then gres := public.pokejam_ranked_player_update(m.guest, s.id, true, 'stay', 0, 1, g_opp_idx, g_opp); end if;
    else
      gres := public.pokejam_ranked_player_update(m.guest, s.id, false, 'leave', 0, 1, g_opp_idx, g_opp);
      if not p_dodge then hres := public.pokejam_ranked_player_update(m.host, s.id, true, 'stay', 0, 1, h_opp_idx, h_opp); end if;
    end if;
  end if;
  perform set_config('pokejam.shield_match', '', true);

  v_res := jsonb_build_object('season', s.number, 'reason', p_reason, 'winner', v_winner, 'dodge', p_dodge,
    'host', hres, 'guest', gres);
  insert into public.pokejam_ranked_matches(match_id, season_id, host_id, guest_id, winner, reason, margin_share,
      host_before, host_after, host_delta, host_event, guest_before, guest_after, guest_delta, guest_event, result,
      host_shield_saved, guest_shield_saved)
    values (p_match, s.id, m.host, m.guest, v_winner, case when p_reason = 'forfeit' then 'forfeit' else p_reason end,
      case when v_known then v_diff::numeric / v_total end,
      (hres->>'before')::int, (hres->>'after')::int, (hres->>'delta')::int, hres->>'event',
      (gres->>'before')::int, (gres->>'after')::int, (gres->>'delta')::int, gres->>'event', v_res,
      case when (hres#>>'{shield,used}')::boolean then (hres#>>'{shield,saved}')::int end,
      case when (gres#>>'{shield,used}')::boolean then (gres#>>'{shield,saved}')::int end)
    on conflict (match_id) do nothing;
  delete from public.pokejam_shield_armed where user_id in (m.host, m.guest);
  if p_reason = 'score' then
    perform public.pokejam_weekly_progress(m.host, p_match, v_winner = m.host);
    perform public.pokejam_weekly_progress(m.guest, p_match, v_winner = m.guest);
  end if;
  return v_res;
end $$;

-- ---------- season rollover ----------
-- As 20261111, plus: every arm is cleared when a season closes.
create or replace function public.pokejam_ranked_open_season_internal(p_length_weeks int default 6)
returns public.pokejam_seasons language plpgsql security definer set search_path = public as $$
declare a public.pokejam_seasons; s public.pokejam_seasons; v_start timestamptz := now(); v_len int := coalesce(p_length_weeks, 6);
begin
  if v_len < 1 or v_len > 52 then raise exception 'bad season length'; end if;
  perform pg_advisory_xact_lock(hashtext('pokejam_ranked_season'));
  select * into a from public.pokejam_seasons where status = 'active' for update;
  if a.id is not null then
    update public.pokejam_ranked_profiles set final_score = case when status = 'ranked'
        then public.pokejam_ranked_ladder(div_idx, points) else seed_score end
      where season_id = a.id;
    insert into public.pokejam_ranked_season_results(user_id, season_id, peak_idx, final_score, wins, losses)
      select user_id, season_id, peak_idx, final_score, wins, losses from public.pokejam_ranked_profiles where season_id = a.id
      on conflict (user_id, season_id) do update set peak_idx = excluded.peak_idx, final_score = excluded.final_score,
        wins = excluded.wins, losses = excluded.losses;
    update public.pokejam_seasons set status = 'closed' where id = a.id;
    delete from public.pokejam_shield_armed;
    -- A season that ran out hands over at its end; one closed early (or long overdue) starts now.
    if a.ends_at <= now() and a.ends_at + v_len * interval '1 week' > now() then v_start := a.ends_at; end if;
  end if;
  insert into public.pokejam_seasons(number, starts_at, length_weeks, ends_at, status)
    values (coalesce((select max(number) from public.pokejam_seasons), 0) + 1, v_start, v_len, v_start + v_len * interval '1 week', 'active')
    returning * into s;
  return s;
end $$;

-- ---------- my rank ----------
-- As 20261111, plus shield_item_count / shield_item_armed / shield_item_next_use (and _locked, _block) for the hub.
-- shield_charge / shield_active keep meaning the automatic Demotion Guard.
create or replace function public.pokejam_ranked_me()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); s public.pokejam_seasons; p public.pokejam_ranked_profiles; v_pts int; v_last int;
        v_out jsonb; v_sh jsonb;
begin
  if me is null then raise exception 'not signed in'; end if;
  s := public.pokejam_ranked_season();
  select * into p from public.pokejam_ranked_profiles where user_id = me and season_id = s.id;
  v_last := public.pokejam_ranked_last_final(me);
  v_sh := public.pokejam_shield_status(me);
  v_out := jsonb_build_object('season', s.number, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
    'days_left', greatest(0, ceil(extract(epoch from (s.ends_at - now())) / 86400)::int), 'last_final_score', v_last,
    'shield_item_count', v_sh->'count', 'shield_item_armed', v_sh->'armed', 'shield_item_next_use', v_sh->'next_use_at',
    'shield_item_locked', v_sh->'locked', 'shield_item_block', v_sh->'arm_block');
  if p.user_id is null then
    return v_out || jsonb_build_object('status', 'placing', 'placements_played', 0, 'placements_left', 5, 'shield_charge', 1,
      'cooldown_until', null);
  end if;
  v_out := v_out || jsonb_build_object('status', p.status, 'shield_charge', p.shield_charge,
    'shield_losses_left', case when p.shield_charge = 0 then 3 - p.losses_since_shield end,
    'cooldown_until', case when p.cooldown_until > now() then p.cooldown_until end, 'leaves_24h', p.leaves_24h);
  if p.status = 'placing' then
    return v_out || jsonb_build_object('placements_played', p.placements_played, 'placements_left', 5 - p.placements_played);
  end if;
  v_pts := p.points;
  if p.div_idx = 24 and p.last_game_at is not null then
    v_pts := public.pokejam_ranked_zenith_decay(p.points, floor(extract(epoch from (now() - p.last_game_at)) / 86400)::int);
  end if;
  return v_out || jsonb_build_object('placements_played', 5, 'placements_left', 0, 'div_idx', p.div_idx, 'points', v_pts,
    'tier', public.pokejam_ranked_tier_name(p.div_idx), 'division', public.pokejam_ranked_division(p.div_idx),
    'zenith', p.div_idx = 24, 'peak_idx', p.peak_idx, 'wins', p.wins, 'losses', p.losses,
    'shield_active', p.div_idx <= 8);
end $$;

-- ---------- privileges ----------
revoke all on function
  public.pokejam_weekly_start(), public.pokejam_weekly_cfg(date), public.pokejam_shield_grant_weekly(uuid,date),
  public.pokejam_weekly_progress(uuid,uuid,boolean), public.pokejam_shield_arm_state(uuid), public.pokejam_shield_block(uuid),
  public.pokejam_shield_status(uuid), public.pokejam_shield_me(), public.pokejam_shield_arm(boolean),
  public.pokejam_shield_consume(uuid,uuid,int),
  public.pokejam_ranked_player_update(uuid,int,boolean,text,int,int,int,int),
  public.pokejam_ranked_apply(uuid,text,uuid,boolean), public.pokejam_ranked_open_season_internal(int), public.pokejam_ranked_me()
  from public, anon, authenticated;
grant execute on function public.pokejam_shield_me(), public.pokejam_shield_arm(boolean), public.pokejam_ranked_me() to authenticated;
