-- Per-match network stats (netcode lag work): each player's client reports how the link behaved, so the next lag
-- report can be explained (RTT, TURN protocol, Realtime fallback, stalls). Additive: older clients never write it.
-- No IP addresses and no location; nothing here identifies the opponent beyond the match id.
--
-- A player can insert and read only their own row, and only for a match they are in (host or guest), including a
-- match that ended void. One row per player per match.

create table if not exists public.pokejam_match_net_stats (
  match_id uuid not null references public.pokejam_matches(id) on delete cascade,
  user_id uuid not null references public.pokejam_profiles(id) on delete cascade,
  rtt_median_ms numeric check (rtt_median_ms between 0 and 60000),
  rtt_p95_ms numeric check (rtt_p95_ms between 0 and 60000),
  relay_protocol text not null default 'unknown' check (relay_protocol in ('udp', 'tcp', 'tls', 'unknown')),
  used_realtime_fallback boolean not null default false,
  stalls_per_min numeric not null default 0 check (stalls_per_min between 0 and 10000),
  stalls int not null default 0 check (stalls between 0 and 1000000),
  duration_s int not null default 0 check (duration_s between 0 and 86400),
  start_delay int check (start_delay between 0 and 120),
  final_delay int check (final_delay between 0 and 120),
  max_delay int check (max_delay between 0 and 120),
  desyncs int not null default 0 check (desyncs between 0 and 100000),
  proto_version int check (proto_version between 0 and 1000),
  client_version text check (length(client_version) <= 40),
  created_at timestamptz not null default now(),
  unique (match_id, user_id)
);

alter table public.pokejam_match_net_stats enable row level security;
revoke all on public.pokejam_match_net_stats from anon, authenticated, public;
grant select, insert on public.pokejam_match_net_stats to authenticated;

create policy "pokejam net stats own read" on public.pokejam_match_net_stats
  for select to authenticated using (user_id = (select auth.uid()));

create policy "pokejam net stats own insert" on public.pokejam_match_net_stats
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.pokejam_matches m
                where m.id = match_id and (select auth.uid()) in (m.host, m.guest)));
