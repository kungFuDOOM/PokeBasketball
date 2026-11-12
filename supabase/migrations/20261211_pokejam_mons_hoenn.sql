-- Keeps the server's Pokémon list in step with the game's (src/data/pokemon.ts): the 121 Gen 3 Pokémon
-- (#252-386) added with the Hoenn League. The fourteen Hoenn Pokémon already in the game are in 20261101. Social
-- drafts deal from this list, so apply it after the client with these Pokémon is live. Safe to run again.
insert into public.pokejam_mons(dex, pos) values
  (252,'PG'), (253,'PG'), (255,'SG'), (256,'SG'), (258,'SG'), (259,'SF'), (261,'SG'), (262,'SF'), (263,'PG'), (264,'PG'),
  (265,'SF'), (266,'SF'), (267,'SG'), (268,'SF'), (269,'SF'), (270,'SF'), (271,'SF'), (272,'SF'), (273,'SF'), (274,'SG'),
  (275,'SF'), (276,'PG'), (277,'PG'), (278,'PG'), (279,'SF'), (280,'PG'), (281,'SG'), (283,'PG'), (284,'SG'), (285,'PG'),
  (286,'PF'), (287,'SF'), (288,'SF'), (289,'C'), (290,'SG'), (291,'PG'), (292,'SG'), (293,'SF'), (294,'SF'), (295,'PF'),
  (296,'PF'), (297,'C'), (298,'SF'), (299,'C'), (300,'PG'), (301,'SG'), (302,'SG'), (304,'SF'), (305,'PF'), (306,'C'),
  (307,'PG'), (308,'SF'), (309,'PG'), (311,'PG'), (312,'PG'), (313,'PG'), (314,'PG'), (315,'PG'), (316,'SG'), (317,'C'),
  (318,'SG'), (319,'SF'), (320,'C'), (321,'C'), (322,'SG'), (323,'C'), (324,'SF'), (325,'PG'), (326,'PG'), (327,'SG'),
  (328,'PF'), (329,'SG'), (330,'C'), (331,'SG'), (332,'SF'), (333,'PG'), (334,'SF'), (335,'SF'), (336,'PF'), (337,'SG'),
  (338,'PF'), (339,'PG'), (340,'PF'), (341,'SG'), (342,'SF'), (343,'PG'), (344,'C'), (345,'SF'), (346,'C'), (347,'SG'),
  (348,'C'), (349,'PG'), (351,'PG'), (352,'PF'), (353,'SG'), (354,'SF'), (355,'SF'), (356,'C'), (357,'C'), (358,'PG'),
  (359,'PF'), (360,'SF'), (361,'SG'), (362,'C'), (363,'SF'), (364,'SF'), (365,'C'), (366,'SF'), (367,'PF'), (368,'SF'),
  (369,'PF'), (370,'PG'), (371,'SG'), (372,'PF'), (374,'SF'), (375,'C'), (377,'C'), (378,'C'), (379,'C'), (385,'PG'),
  (386,'SG')
on conflict (dex) do update set pos = excluded.pos;
