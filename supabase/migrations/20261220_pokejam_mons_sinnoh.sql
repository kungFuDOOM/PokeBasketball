-- Keeps the server's Pokémon list in step with the game's (src/data/pokemon.ts): the 92 Gen 4 Pokémon
-- (#387-493) added with the Sinnoh League. The fifteen Sinnoh Pokémon already in the game are in 20261101 and
-- 20261102. Social drafts deal from this list, so apply it after the client with these Pokémon is live. Safe to run again.
insert into public.pokejam_mons(dex, pos) values
  (387,'SF'), (388,'PF'), (389,'C'), (390,'PG'), (391,'SG'), (393,'SG'), (394,'SG'), (395,'C'), (396,'PG'), (397,'PG'),
  (398,'PF'), (399,'SF'), (400,'SF'), (401,'SF'), (402,'SF'), (403,'SG'), (404,'SG'), (406,'PG'), (407,'PG'), (408,'PF'),
  (409,'PF'), (410,'SF'), (411,'C'), (412,'PG'), (413,'SG'), (414,'SG'), (415,'PG'), (416,'PF'), (417,'PG'), (418,'SG'),
  (419,'SG'), (420,'SG'), (421,'PG'), (422,'SG'), (423,'PF'), (424,'SF'), (425,'PG'), (426,'PF'), (427,'PG'), (428,'SF'),
  (429,'PG'), (430,'SF'), (431,'PG'), (432,'PG'), (433,'PG'), (434,'PG'), (435,'SF'), (436,'SF'), (438,'PF'), (439,'PG'),
  (440,'SF'), (441,'PG'), (442,'SF'), (443,'SF'), (444,'SF'), (446,'PF'), (447,'SG'), (449,'PF'), (450,'C'), (451,'SF'),
  (452,'PF'), (453,'SG'), (455,'PF'), (456,'PG'), (457,'SF'), (458,'PG'), (459,'SG'), (460,'C'), (463,'C'), (467,'SG'),
  (469,'SF'), (471,'SG'), (472,'C'), (474,'SG'), (476,'C'), (477,'C'), (478,'SF'), (479,'PG'), (480,'PG'), (481,'SG'),
  (482,'SG'), (483,'C'), (484,'C'), (485,'C'), (486,'C'), (487,'C'), (488,'C'), (489,'PG'), (490,'PG'), (491,'SG'),
  (492,'PG'), (493,'C')
on conflict (dex) do update set pos = excluded.pos;
