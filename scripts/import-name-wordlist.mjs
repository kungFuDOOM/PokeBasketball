// One-off importer for the username profanity list (src/multiplayer/ranked/nameFilterData.json).
// Source: the English dataset of `obscenity` (MIT, https://github.com/jo3-l/obscenity), itself derived from `cuss` (MIT).
// Usage: node scripts/import-name-wordlist.mjs <path to unpacked obscenity package>   (e.g. after `npm pack obscenity`)
// It reads dist/preset/english.js as text (no code is run), flattens each phrase's patterns into plain letter strings, sorts the
// terms into "severe" (blocked anywhere in a name) and "mild" (blocked only as a whole name or a whole `_` segment), and keeps
// the dataset's own whitelisted words as the allowlist. The hand-kept parts (reserved names, impersonation, extra allowlist
// words) are NOT overwritten: they are read from the existing JSON if present.
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = process.argv[2];
if (!pkg) throw new Error('usage: node scripts/import-name-wordlist.mjs <obscenity package dir>');
const out = new URL('../src/multiplayer/ranked/nameFilterData.json', import.meta.url);
const src = readFileSync(`${pkg}/dist/preset/english.js`, 'utf8');
const license = readFileSync(`${pkg}/LICENSE.md`, 'utf8');
const version = JSON.parse(readFileSync(`${pkg}/package.json`, 'utf8')).version;

// Short or ambiguous terms: only an exact whole name / whole `_` segment is blocked, so "assassin" or "analyst" stay legal.
const MILD = new Set(['abo', 'anal', 'anus', 'ass', 'arse', 'cum', 'cock', 'tit', 'tits', 'tiddies', 'tities', 'boob', 'sex', 'sexy', 'scat',
  'nig', 'nigs', 'orgy', 'orgies', 'porn', 'prn', 'fk', 'fuk', 'dck', 'pnis', 'rape', 'wank', 'turd', 'twat', 'prick', 'pricks',
  'hooker', 'semen', 'cuck', 'bich', 'trany', 'titt', 'cocks', 'incest', 'gasm', 'jerkoff', 'felch', 'hentai', 'bollock', 'bollocks', 'bastard']);

// Terms the dataset spells with optional letters (so the importer skips them) or lacks, taken from the game's existing trainer-name filter.
const EXTRA_SEVERE = ['nigga', 'hitler','wetback', 'beaner', 'rapist', 'molest'];

// Innocent words that contain a severe term (the Scunthorpe problem). Kept in addition to the dataset's own whitelist.
const EXTRA_ALLOW = ['scunthorpe', 'penistone', 'pussycat', 'pussywillow', 'shiitake', 'negroni', 'fagin', 'fagan', 'nigeria', 'nigerian',
  'retardant', 'pissarro', 'nigam', 'dickinson', 'dickson', 'dickerson', 'dickey'];
// Names nobody may take (the whole name, after normalising).
const RESERVED = ['admin', 'administrator', 'moderator', 'mod', 'mods', 'pokejam', 'official', 'support', 'staff', 'system', 'dev', 'developer',
  'kungfudoom', 'cryptodoom', 'root', 'null', 'undefined', 'owner', 'founder', 'ceo', 'gm', 'bot', 'server', 'help', 'info', 'security',
  'guest', 'anonymous', 'player', 'trainer', 'unknown', 'deleted', 'none', 'nan', 'true', 'false', 'test', 'pokemon', 'nintendo', 'gamefreak',
  'pokebasketball', 'ranked', 'social', 'cpu'];
// Blocked anywhere in a name (after normalising), except inside an impersonationAllow word ("modern" is not "mod").
const IMPERSONATION = ['admin', 'moderator', 'mod', 'staff', 'official', 'support', 'pokejam', 'kungfudoom', 'cryptodoom'];
const IMPERSONATION_ALLOW = ['modern', 'model', 'modem', 'modest', 'modal', 'module', 'modify', 'modulo', 'modish', 'moderate', 'moderation', 'stafford',
  'staffan', 'moody', 'commodore', 'commodity', 'accommodate'];

const flat = (p) => p.replace(/[|?]/g, '').replace(/[^a-z]/g, '');
const phrases = src.split('.addPhrase(').slice(1);
const terms = new Set();
const allow = new Set();
for (const ph of phrases) {
  const ow = /originalWord:\s*'([^']+)'/.exec(ph);
  if (ow) terms.add(flat(ow[1].toLowerCase()));
  // Patterns with optional letters ([x]) are spelling variants of the original word, which the doubled-letter collapse already covers.
  // `<letter>anal` patterns only catch "...anal" word endings and are noise once separators are stripped.
  for (const m of ph.matchAll(/pattern\)\s*`([^`]*)`/g)) if (!/\[/.test(m[1]) && !/^\|?[a-z]anal\|?$/.test(m[1]) && m[1] !== '|cockp') terms.add(flat(m[1].toLowerCase()));
  // Whitelisted words with a space guard against a match across two words; names here never contain spaces, so skip those.
  for (const m of ph.matchAll(/addWhitelistedTerm\((?:'([^']*)'|"([^"]*)")\)/g)) { const w = (m[1] ?? m[2]).toLowerCase(); if (/^[a-z]+$/.test(w)) allow.add(w); }
}
for (const t of EXTRA_SEVERE) terms.add(t);
terms.delete('');
allow.delete('');
// A pattern like `|cocks` flattens to a prefix ("cocks", "cockp"): keep only terms of 3+ letters.
// "fu" would block the legitimate segment in Kung_Fu; "doublepenetra" is a stem of "doublepenetration".
const DROP = new Set(['fu', 'doublepenetra']);
const all = [...terms].filter((t) => t.length >= 2 && !DROP.has(t)).sort();
const data = {
  source: `obscenity ${version} English dataset (MIT), derived from cuss (MIT). Regenerate with scripts/import-name-wordlist.mjs; see docs/third-party-wordlist.md.`,
  severe: all.filter((t) => !MILD.has(t)),
  mild: all.filter((t) => MILD.has(t)),
  // Innocent words that contain a severe term (the Scunthorpe problem), removed before the substring check.
  allow: [...new Set([...[...allow].filter((w) => w.length >= 5), ...EXTRA_ALLOW])].sort(),
  // Names nobody may take (the whole name, after normalising).
  reserved: RESERVED,
  // Names that would pass for staff: blocked anywhere in a name (after normalising), except inside an impersonationAllow word.
  impersonation: IMPERSONATION,
  impersonationAllow: IMPERSONATION_ALLOW,
};
writeFileSync(out, `${JSON.stringify(data, null, 1)}\n`);
writeFileSync(new URL('../third-party/obscenity-LICENSE.md', import.meta.url), license);
console.log(`severe ${data.severe.length}, mild ${data.mild.length}, allow ${data.allow.length}`);
