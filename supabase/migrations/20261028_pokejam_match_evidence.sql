-- PokeJam online: signed evidence for the winner check (src/multiplayer/shared/evidence.ts, winnerCheck.ts).
-- Shared gauntlet-legends project: pokejam_* only.
--
-- Each player registers a fresh Ed25519 public key on the match row before tip-off (once: it can't be changed
-- later, so nobody can swap keys after seeing the result), signs every input batch they send, and uploads
-- everything signed they hold after the game (once per player per match). A judge (judge() in an Edge Function)
-- replays the match from the uploads. Players can't read the uploads; only the service role can.

alter table public.pokejam_matches
  add column if not exists host_key text,
  add column if not exists guest_key text;
alter table public.pokejam_matches drop constraint if exists pokejam_matches_keys_hex;
alter table public.pokejam_matches add constraint pokejam_matches_keys_hex
  check ((host_key is null or host_key ~ '^[0-9a-f]{64}$') and (guest_key is null or guest_key ~ '^[0-9a-f]{64}$'));

create table if not exists public.pokejam_match_evidence (
  match_id uuid not null references public.pokejam_matches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- evidence.ts pack(): 'gz1:' + base64 of the gzipped Evidence JSON. A long game is a few hundred KB at most.
  evidence text not null check (evidence like 'gz1:%' and octet_length(evidence) <= 4000000),
  created_at timestamptz not null default now(),
  primary key (match_id, user_id)
);
alter table public.pokejam_match_evidence enable row level security;
revoke all on public.pokejam_match_evidence from anon, authenticated, public;

-- Register my key for a match I'm in, before tip-off. True when the key on the row is this one (a repeat of the
-- same key is fine); false if a different key is already registered: keys never change.
create or replace function public.pokejam_register_key(p_match uuid, p_key text)
returns boolean language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'bad key'; end if;
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null or me not in (m.host, m.guest) or m.status <> 'active' or m.created_at < now() - interval '3 hours' then
    raise exception 'not in this match';
  end if;
  if me = m.host then
    update public.pokejam_matches set host_key = coalesce(host_key, p_key) where id = p_match returning * into m;
    return m.host_key = p_key;
  end if;
  update public.pokejam_matches set guest_key = coalesce(guest_key, p_key) where id = p_match returning * into m;
  return m.guest_key = p_key;
end $$;

-- Upload my evidence for a match I played (once; later uploads are ignored). True when it was stored.
create or replace function public.pokejam_submit_evidence(p_match uuid, p_evidence text)
returns boolean language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or me not in (m.host, m.guest) or m.created_at < now() - interval '6 hours' then raise exception 'not in this match'; end if;
  if p_evidence is null or p_evidence not like 'gz1:%' or octet_length(p_evidence) > 4000000 then raise exception 'bad evidence'; end if;
  insert into public.pokejam_match_evidence(match_id, user_id, evidence) values (p_match, me, p_evidence)
    on conflict (match_id, user_id) do nothing;
  return found;
end $$;

-- Match info now includes both registered keys (each player needs the other's to know it's on the row).
create or replace function public.pokejam_match_info(p_match uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', m.id, 'queue', m.queue, 'status', m.status, 'host', m.host, 'guest', m.guest,
    'host_name', hp.trainer_name, 'guest_name', gp.trainer_name, 'seed', m.seed, 'quarter_len', m.quarter_len,
    'host_key', m.host_key, 'guest_key', m.guest_key)
  from public.pokejam_matches m
  join public.pokejam_profiles hp on hp.id = m.host
  left join public.pokejam_profiles gp on gp.id = m.guest
  where m.id = p_match and auth.uid() in (m.host, m.guest);
$$;

revoke all on function public.pokejam_register_key(uuid, text), public.pokejam_submit_evidence(uuid, text) from public, anon, authenticated;
grant execute on function public.pokejam_register_key(uuid, text), public.pokejam_submit_evidence(uuid, text) to authenticated;
