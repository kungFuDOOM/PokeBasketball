import { beforeAll, describe, expect, it } from 'vitest';
import type { Mon } from '../data/pokemon';
import type { TeamDef } from '../game/types';
import { IntroVotes } from './intro.logic';
import { introHtml } from './intro';

const mon = (dex: number, name: string, pos: string, ovr: number) => ({ dex, name, pos, ovr }) as unknown as Mon;
const team = (name: string, color: string): TeamDef => ({
  name,
  abbr: name.slice(0, 3).toUpperCase(),
  color,
  color2: '#fff',
  human: true,
  roster: [mon(25, 'Pikachu', 'PG', 80), mon(1, 'Bulbasaur', 'SG', 70), mon(4, 'Charmander', 'SF', 72), mon(7, 'Squirtle', 'PF', 74), mon(143, 'Snorlax', 'C', 90)],
});

beforeAll(() => {
  // spriteUrl reads window.__POKE_SPRITES; there is no DOM environment in these tests.
  (globalThis as { window?: unknown }).window ??= {};
});

describe('introHtml', () => {
  it('renders two team columns with five rows each, VS and a Skip button', () => {
    const html = introHtml({ home: team('Home <Team>', '#f00'), away: team('Away', '#00f') });
    expect(html.match(/class="intro-team[" ]/g)).toHaveLength(2);
    expect(html.match(/<li>/g)).toHaveLength(10);
    expect(html).toContain('class="intro-vs">VS<');
    expect(html).toContain('class="btn intro-skip"');
    expect(html).toContain('>Skip<');
    expect(html).toContain('Home &lt;Team&gt;');
    expect(html).not.toContain('Home <Team>');
    expect(html).toContain('Snorlax');
    expect(html).toMatch(/<img src="[^"]*"/);
  });

  it('shows rank chips only when labels are given', () => {
    expect(introHtml({ home: team('A', '#f00'), away: team('B', '#00f') })).not.toContain('intro-rank');
    const html = introHtml({ home: team('A', '#f00'), away: team('B', '#00f'), homeLabel: 'Gold II', awayLabel: 'Silver I' });
    expect(html).toContain('Gold II');
    expect(html).toContain('Silver I');
  });

  it('online: the button label comes from the votes', () => {
    const votes = new IntroVotes();
    votes.vote('theirs', true);
    const html = introHtml({ home: team('A', '#f00'), away: team('B', '#00f'), online: { votes, onVote: () => {} }, mySide: 1 });
    expect(html).toContain('1/2 ready');
    expect(html).toMatch(/intro-team mine"[^>]*>\s*<h2>B</);
  });
});
