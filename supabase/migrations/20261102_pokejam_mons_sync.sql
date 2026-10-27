-- Keeps the server's Pokémon list in step with the game's (src/data/pokemon.ts): the rookie additions
-- (Mawile, Braviary, Tyrantrum, Tinkaton) and Leafeon's move to point guard. Safe to run again.
insert into public.pokejam_mons(dex, pos) values
  (303,'PG'), (470,'PG'), (628,'PF'), (697,'C'), (959,'SG')
on conflict (dex) do update set pos = excluded.pos;
