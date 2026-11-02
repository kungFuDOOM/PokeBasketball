// Writes the username word-list seed into supabase/migrations/20261114_pokejam_profiles.sql (between the GENERATED markers)
// from src/multiplayer/ranked/nameFilterData.json, so the server and client lists can't drift. Run after editing the JSON:
//   node scripts/gen-name-filter-sql.mjs
// `--check` only compares and exits 1 if the migration is stale (the vitest sync test does the same through nameFilterSql()).
import { readFileSync, writeFileSync } from 'node:fs';

const DATA = new URL('../src/multiplayer/ranked/nameFilterData.json', import.meta.url);
const SQL = new URL('../supabase/migrations/20261114_pokejam_profiles.sql', import.meta.url);
const KINDS = [['severe', 'severe'], ['mild', 'mild'], ['allow', 'allow'], ['reserved', 'reserved'], ['impersonation', 'impersonation'],
  ['impersonationAllow', 'impersonation_allow']];

export function seedBlock(data) {
  const rows = KINDS.flatMap(([key, kind]) => [...new Set(data[key])].sort().map((t) => `  ('${kind}', '${t}')`));
  return `-- BEGIN GENERATED
-- Source: src/multiplayer/ranked/nameFilterData.json (${data.source})
-- Regenerate: node scripts/gen-name-filter-sql.mjs. Mild terms are stored as written (matched with pokejam_name_mild_rx);
-- every other kind is stored with repeated letters collapsed, like the names it is compared with.
delete from public.pokejam_name_blocklist;
insert into public.pokejam_name_blocklist(kind, term)
  select v.kind, case when v.kind = 'mild' then v.term else public.pokejam_name_collapse(v.term) end
  from (values
${rows.join(',\n')}
  ) as v(kind, term)
  on conflict do nothing;
-- END GENERATED`;
}

export function withSeed(sql, data) {
  return sql.replace(/-- BEGIN GENERATED[\s\S]*?-- END GENERATED/, () => seedBlock(data));
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const data = JSON.parse(readFileSync(DATA, 'utf8'));
  const cur = readFileSync(SQL, 'utf8');
  const next = withSeed(cur, data);
  if (process.argv.includes('--check')) process.exit(cur === next ? 0 : 1);
  writeFileSync(SQL, next);
  console.log('seed written');
}
