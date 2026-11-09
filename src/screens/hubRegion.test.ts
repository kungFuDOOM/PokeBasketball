import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POKEMON } from '../data/pokemon';
import { LEAGUE, awardRegion, createFranchise, enterRegion, finishRookieDraft, rookieOnClock, rookiePick, seasonWeeks, startRookieDraft, type Franchise } from '../franchise/league';
import { openRegionIds, poolMons } from '../franchise/regions';
import { autoDraft } from '../season/team';
import { championBannerHtml, nextCard, regionCardHtml, standingsHtml } from './hub';
import type { Settings } from './menu';

vi.stubGlobal('window', {});
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});
beforeEach(() => store.clear());

const settings = { quarterLen: 60, difficulty: 'pro' } as unknown as Settings;
const actions = (html: string) => [...html.matchAll(/data-a="([\w-]+)"/g)].map((m) => m[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function kanto(unlocked: string[] = []): Franchise {
  const teams = [{ name: 'Me', abbr: 'MEE', color: '#3b6fd8', color2: '#16224a', human: true }, ...LEAGUE.map((t) => ({ ...t, human: false }))];
  const { rosters, leftovers } = autoDraft(teams, 10, undefined, poolMons(openRegionIds(unlocked)));
  const used = new Set([...rosters.flat(), ...leftovers]);
  const f = createFranchise(teams, rosters, [...leftovers, ...POKEMON.filter((m) => !used.has(m))]);
  if (unlocked.length) f.unlockedRegions = unlocked;
  return f;
}

/** Final over: the user beat `beat` (team ids) and `champ` won the title. */
function finish(f: Franchise, beat: number[], champ: number) {
  for (const g of f.games) {
    const opp = g.home === 0 ? g.away : g.away === 0 ? g.home : -1;
    const userWins = opp >= 0 && beat.indexOf(opp) >= 0;
    g.score = opp < 0 ? [80, 70] : (g.home === 0) === userWins ? [90, 80] : [80, 90];
  }
  f.phase = 'done';
  f.week = seasonWeeks(f) + 2;
  f.champion = champ;
  awardRegion(f);
}

function rookieDraft(f: Franchise) {
  startRookieDraft(f);
  while (rookieOnClock(f)) rookiePick(f);
  finishRookieDraft(f, f.teams[0].roster[f.teams[0].roster.length - 1]);
}

describe('hub: the next region', () => {
  it('while locked, lists the Kanto badges and the Kanto championship separately', () => {
    const f = kanto();
    finish(f, [1, 2, 3], 4);
    const html = regionCardHtml(f);
    expect(text(html)).toContain('Johto is locked');
    const reqs = [...html.matchAll(/<li class="(ok|todo)">([\s\S]*?)<\/li>/g)].map((m) => [m[1], text(m[2])]);
    expect(reqs).toEqual([['todo', '· Kanto badges 3/8'], ['todo', '· Kanto championship Not won']]);
    expect(actions(html)).not.toContain('enter-region');

    const title = kanto();
    finish(title, [1, 2, 3, 4, 5, 6, 7], 0);
    const reqs2 = [...regionCardHtml(title).matchAll(/<li class="(ok|todo)">([\s\S]*?)<\/li>/g)].map((m) => [m[1], text(m[2])]);
    expect(reqs2).toEqual([['todo', '· Kanto badges 7/8'], ['ok', '✓ Kanto championship Won']]);
  });

  it('once unlocked: explained in the offseason, then an Enter Johto button at the start of the season', () => {
    const f = kanto();
    finish(f, f.teams.filter((t) => t.gym).map((t) => t.id), 0);
    const offseason = regionCardHtml(f);
    expect(text(offseason)).toContain('Johto unlocked');
    expect(text(offseason)).toContain('after the rookie draft');
    expect(actions(offseason)).not.toContain('enter-region');
    rookieDraft(f);
    const start = regionCardHtml(f);
    expect(actions(start)).toContain('enter-region');
    expect(start).toContain('data-region="johto"');
    expect(text(start)).toContain('Gen 2 Pokémon (#152–251)');
    expect(text(start)).toContain('Falkner to Clair');
    // The usual game card is still there.
    expect(actions(nextCard(f, settings))).toEqual(expect.arrayContaining(['play', 'watch-mine', 'sim-mine']));

    expect(enterRegion(f, 'johto')).toBe(true);
    // In Johto, the card moves on to Hoenn: locked, with this season's Johto progress.
    const hoenn = regionCardHtml(f);
    expect(text(hoenn)).toContain('Hoenn is locked');
    expect(text(hoenn)).toContain('Johto badges 0/8');
    expect(actions(hoenn)).not.toContain('enter-region');
    const card = text(nextCard(f, settings));
    expect(card).toContain('Violet Soar');
    expect(card).toContain('Gym Leader Falkner · Zephyr Badge on the line');
    expect(card).toMatch(/\d+ OVR/);
    // The standings keep the Johto Elite's full coach label, as text and as a title (the line wraps on phones).
    expect(standingsHtml(f)).toContain('<small title="Will · Koga · Bruno · Karen · Champion Lance">Will · Koga · Bruno · Karen · Champion Lance</small>');
  });

  it('shows the Kanto Champion banner after any Kanto title, and nothing for anyone else', () => {
    expect(championBannerHtml(kanto())).toBe('');
    expect(championBannerHtml(kanto(['johto']))).toBe('');
    const cpu = kanto();
    finish(cpu, [], 2);
    expect(championBannerHtml(cpu)).toBe('');
    const f = kanto();
    finish(f, [1], 0);
    expect(text(championBannerHtml(f))).toBe('Kanto Champion Season 1');
    // A title alone is not the unlock.
    expect(text(regionCardHtml(f))).toContain('Johto is locked');
  });
});
