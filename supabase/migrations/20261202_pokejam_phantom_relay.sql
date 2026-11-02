-- PokeJam: a short-lived mailbox for Phantom's deeplink answers. Shared gauntlet-legends project: pokejam_* only.
-- Additive: one new table and two functions. See docs/phantom-mobile-signin.md.
--
-- Phantom sends the player back to a browser tab that often doesn't hold the decryption key: the home-screen app's redirect opens
-- in Safari, and browsers may open a new tab (sessionStorage is per tab). That tab leaves the still-encrypted answer here, under the
-- random id from the redirect link; the tab that started the sign-in fetches it and decrypts it.
--
-- Stores ciphertext only: the shape check refuses anything but Phantom's public key, nonce and box, or a numeric error code.
-- A row lasts 5 minutes and is deleted when read. Expired rows are ignored by take and purged on every put and take.
-- Both functions are open to anon on purpose: Safari may have no session. The id is the only key, so nothing can be listed.

create table if not exists public.pokejam_phantom_relay (
  id text primary key,
  payload jsonb not null,
  -- md5 of the caller's IP, for the per-client cap below. Gone with the row.
  client_key text,
  expires_at timestamptz not null
);
alter table public.pokejam_phantom_relay enable row level security;
revoke all on public.pokejam_phantom_relay from anon, authenticated, public;

create index if not exists pokejam_phantom_relay_expires on public.pokejam_phantom_relay (expires_at);
create index if not exists pokejam_phantom_relay_client on public.pokejam_phantom_relay (client_key);

-- True when stored. False for a bad shape, a used id (first writer wins), or over a cap.
create or replace function public.pokejam_phantom_relay_put(p_id text, p_payload jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  b58 constant text := '^[1-9A-HJ-NP-Za-km-z]+$';
  headers jsonb;
  client text;
begin
  delete from public.pokejam_phantom_relay where expires_at <= now();

  if p_id is null or length(p_id) not between 32 and 44 or p_id !~ b58 then return false; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 4096 then return false; end if;
  if exists (select 1 from jsonb_object_keys(p_payload) key where key not in ('k', 'n', 'd', 'e')) then return false; end if;
  if p_payload ? 'e' then
    if (select count(*) from jsonb_object_keys(p_payload)) <> 1
      or jsonb_typeof(p_payload -> 'e') <> 'string' or (p_payload ->> 'e') !~ '^-?[0-9]{1,6}$' then return false; end if;
  else
    if jsonb_typeof(p_payload -> 'n') is distinct from 'string' or jsonb_typeof(p_payload -> 'd') is distinct from 'string'
      or (p_payload ->> 'n') !~ b58 or (p_payload ->> 'd') !~ b58 then return false; end if;
    if p_payload ? 'k' and (jsonb_typeof(p_payload -> 'k') <> 'string' or (p_payload ->> 'k') !~ b58) then return false; end if;
  end if;

  -- PostgREST exposes the request's headers. No header (as in tests or a direct connection) means no per-client cap.
  begin
    headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then headers := null;
  end;
  client := coalesce(headers ->> 'cf-connecting-ip', split_part(headers ->> 'x-forwarded-for', ',', 1));
  if nullif(client, '') is not null then
    client := md5(client);
    if (select count(*) from public.pokejam_phantom_relay where client_key = client) >= 20 then return false; end if;
  else
    client := null;
  end if;
  if (select count(*) from public.pokejam_phantom_relay) >= 5000 then return false; end if;

  insert into public.pokejam_phantom_relay (id, payload, client_key, expires_at)
    values (p_id, p_payload, client, now() + interval '5 minutes')
    on conflict (id) do nothing;
  return found;
end $$;

-- The stored answer, once; null when nothing is there (yet).
create or replace function public.pokejam_phantom_relay_take(p_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  answer jsonb;
begin
  delete from public.pokejam_phantom_relay where expires_at <= now();
  delete from public.pokejam_phantom_relay where id = p_id returning payload into answer;
  return answer;
end $$;

revoke all on function public.pokejam_phantom_relay_put(text, jsonb) from public;
revoke all on function public.pokejam_phantom_relay_take(text) from public;
grant execute on function public.pokejam_phantom_relay_put(text, jsonb) to anon, authenticated;
grant execute on function public.pokejam_phantom_relay_take(text) to anon, authenticated;
