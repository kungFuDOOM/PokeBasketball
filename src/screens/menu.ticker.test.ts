import { describe, expect, it } from 'vitest';
import { weeklyChallengesTickerHtml } from '../raffle/challengesView';
import { tickerHtml } from './menu';

describe('menu ticker', () => {
  it('adds one weekly-challenges line and leaves the other items in place', () => {
    const html = tickerHtml(false, true);
    const promo = weeklyChallengesTickerHtml();
    expect(html.split(promo).length - 1).toBe(2);
    expect(html.match(/data-go="ticker-challenges"/g)?.length).toBe(2);
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('<b class="tk-tag">LIVE</b>');
    expect(html).toContain('Hold shoot, release on green: a perfect release never misses');
    expect(html).toContain('<b>NEW</b> Season Draft: draft ten, sim a full season, share your team');
    expect(html).toContain('Franchise: 9-week seasons, badges, level-ups and evolutions');
    expect(html).toContain('Quick Play: draft five, pick a gym leader, tip off');
    expect(html).toContain('$PJAM, the official PokeJam token');
    expect(html).toContain('Your ad here');
    expect(html).toContain('role="marquee"');
  });

  it('keeps the promo as text when the challenges panel is not wired', () => {
    const html = tickerHtml(false, false);
    expect(html).toContain(weeklyChallengesTickerHtml());
    expect(html).not.toContain('data-go="ticker-challenges"');
  });

  it('puts a short tappable challenges label on the static line with the modes', () => {
    const html = tickerHtml(true, true);
    expect(html).toContain('class="ticker static"');
    expect(html).toContain('>Season Draft</span>');
    expect(html).toContain('>Franchise</span>');
    expect(html).toContain('>Quick Play</span>');
    expect(html).toContain('data-go="ticker-challenges">Weekly Challenges</button>');
    expect(html.match(/class="tk-item/g)?.length).toBe(4);
  });
});
