-- Pack Battles on Collector Crypt's builder-fee machines (partner API).
--
-- Collector Crypt lets an approved partner run its own copy of a builder-fee machine (bf_poke25, bf_poke50,
-- bf_poke100) and earn a fee on every pack: half when the pack is sold, half when its card is sold back. The fee
-- comes out of the pack's expected value, not its price, so the pot a battle escrows is unchanged.
--
-- No double dip: on a tier whose pull comes from our fee-earning machine, players pay no Pack Battles fee of their
-- own. Every other tier keeps pack_fee_bps (default 5% of the pot). The machines function records, per tier, the
-- machine code it resolved and that machine's partner fee; pokejam_pack_entry_cost reads it at entry.

alter table public.pokejam_pack_machines add column if not exists machine_code text;
alter table public.pokejam_pack_machines add column if not exists partner_fee_micro bigint not null default 0;
alter table public.pokejam_pack_machines drop constraint if exists pokejam_pack_machines_partner_fee_check;
alter table public.pokejam_pack_machines add constraint pokejam_pack_machines_partner_fee_check check (partner_fee_micro >= 0);

create or replace function public.pokejam_pack_upsert_machines(p_rows jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.pokejam_pack_machines(code, price_micro, available, why, odds, ev, buyback, machine_code, partner_fee_micro, updated_at)
  select r.code, r.price_micro, coalesce(r.available, false), r.why, r.odds, r.ev, r.buyback, r.machine_code,
    greatest(coalesce(r.partner_fee_micro, 0), 0), now()
  from jsonb_to_recordset(p_rows) as r(code text, price_micro bigint, available boolean, why text, odds jsonb, ev numeric,
    buyback numeric, machine_code text, partner_fee_micro bigint)
  where r.code in ('pokemon_25', 'pokemon_50', 'pokemon_100')
  on conflict (code) do update set price_micro = excluded.price_micro, available = excluded.available, why = excluded.why,
    odds = excluded.odds, ev = excluded.ev, buyback = excluded.buyback, machine_code = excluded.machine_code,
    partner_fee_micro = excluded.partner_fee_micro, updated_at = excluded.updated_at;
$$;

-- What one player pays to enter a tier: half the pot, plus half the Pack Battles fee unless the tier's machine
-- already earns us Collector Crypt's partner fee.
create or replace function public.pokejam_pack_entry_cost(p_tier text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('stake', public.pokejam_pack_tier_price(p_tier) / 2,
    'fee', case
      when exists (select 1 from public.pokejam_pack_machines m where m.code = p_tier and m.partner_fee_micro > 0) then 0
      else public.pokejam_pack_tier_price(p_tier)
        * coalesce((select (value #>> '{}')::int from public.pokejam_config where key = 'pack_fee_bps'), 500) / 20000
    end);
$$;

revoke all on function public.pokejam_pack_upsert_machines(jsonb), public.pokejam_pack_entry_cost(text) from public, anon, authenticated;
