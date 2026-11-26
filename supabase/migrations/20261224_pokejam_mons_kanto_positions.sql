-- Kanto gym stars whose positions moved so both can start. Social drafts deal from pokejam_mons.
-- Alakazam point guard to small forward (Mew stays the point guard), Electrode point guard to shooting guard,
-- Electivire power forward to center. Later rows win: on conflict updates pos.
insert into public.pokejam_mons(dex, pos) values
  (65,'SF'), (101,'SG'), (466,'C')
on conflict (dex) do update set pos = excluded.pos;
