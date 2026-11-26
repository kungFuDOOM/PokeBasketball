-- Position overrides for the legendary ladder. Social drafts deal from pokejam_mons, so these seven
-- follow the hand-tuned rows in src/data/pokemon.ts. Later rows win: on conflict updates pos.
-- Latios SF to SG, Dialga C to PF, Giratina C to PF, Lugia C to PF, Palkia C to SF, Ho-Oh C to SF, Entei C to PF.
insert into public.pokejam_mons(dex, pos) values
  (244,'PF'), (249,'PF'), (250,'SF'), (381,'SG'), (483,'PF'), (484,'SF'), (487,'PF')
on conflict (dex) do update set pos = excluded.pos;
