import { describe, expect, it } from 'vitest';
import { weeklyChallengesTickerHtml } from '../raffle/challengesView';
import { onLiveAdsChange, setLiveAds } from '../data/ads';
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

  it('shows paid ads about five times as often as tips, then falls back to every tip', () => {
    setLiveAds([
      { text: 'RIPIT .CO', theme: 'gold', until: Date.now() + 60_000 },
      { text: 'SECOND AD', theme: 'fire', until: Date.now() + 60_000 },
    ]);
    const html = tickerHtml(false, true);
    const run = html.slice(0, html.indexOf('aria-hidden'));
    const tips = run.match(/<b class="tk-tag">TIP<\/b>/g)?.length ?? 0;
    const head = run.slice(0, run.indexOf('<b class="tk-tag">TIP</b>'));
    expect(tips).toBeGreaterThan(0);
    expect(head.match(/<b class="tk-tag">AD<\/b>/g)?.length).toBe(5);
    const at = (text: string, from: number) => head.indexOf(text, from);
    const ripit = at('RIPIT .CO', 0);
    const pjam = at('$PJAM, the official', ripit + 1);
    const second = at('SECOND AD', pjam + 1);
    const open = at('Your ad here', second + 1);
    const ripitAgain = at('RIPIT .CO', open + 1);
    expect(ripit).toBeGreaterThan(-1);
    expect(pjam).toBeGreaterThan(ripit);
    expect(second).toBeGreaterThan(pjam);
    expect(open).toBeGreaterThan(second);
    expect(ripitAgain).toBeGreaterThan(open);
    expect(run.indexOf('RIPIT .CO')).toBeLessThan(run.indexOf('<b class="tk-tag">TIP</b>'));
    expect(run.indexOf('RIPIT .CO')).toBeLessThan(run.indexOf('SECOND AD'));
    expect(run).toContain('href="https://ripit.co"');
    expect(run.split(weeklyChallengesTickerHtml()).length - 1).toBe(1);
    expect(run).toContain('<b class="tk-tag">LIVE</b>');
    expect(run).toContain('Franchise: 9-week seasons, badges, level-ups and evolutions');
    expect(run).toContain('Your ad here');
    const betweenTips = run.split('<b class="tk-tag">TIP</b>').slice(1, -1);
    for (const gap of betweenTips) expect(gap).toContain('tk-tag">AD');

    setLiveAds([]);
    const fallback = tickerHtml(false, true);
    expect(fallback).not.toContain('RIPIT');
    expect(fallback).not.toContain('SECOND AD');
    expect((fallback.match(/<b class="tk-tag">TIP<\/b>/g) ?? []).length).toBe(tips * 2);
  });

  it('does not repeat the only paid ad: RIPIT, $PJAM, RIPIT, Your ad here, RIPIT', () => {
    setLiveAds([{ text: 'RIPIT .CO', theme: 'gold', until: Date.now() + 60_000 }]);
    const html = tickerHtml(false, true);
    const run = html.slice(0, html.indexOf('aria-hidden'));
    const head = run.slice(0, run.indexOf('<b class="tk-tag">TIP</b>'));
    const order = ['RIPIT .CO', '$PJAM, the official', 'RIPIT .CO', 'Your ad here', 'RIPIT .CO'];
    let from = 0;
    for (const text of order) {
      const at = head.indexOf(text, from);
      expect(at).toBeGreaterThan(-1);
      from = at + text.length;
    }
    expect(head.match(/<b class="tk-tag">AD<\/b>/g)?.length).toBe(5);
    setLiveAds([]);
  });

  it('leads with paid live ads that are still running, before the $PJAM house ad', () => {
    setLiveAds([{ text: 'RIPIT .CO', theme: 'gold', until: Date.now() + 60_000 }, { text: 'OLD', theme: 'gold', until: Date.now() - 1 }]);
    const html = tickerHtml(false, true);
    expect(html.indexOf('RIPIT .CO')).toBeGreaterThan(-1);
    expect(html.indexOf('RIPIT .CO')).toBeLessThan(html.indexOf('$PJAM, the official'));
    expect(html).not.toContain('OLD');
    setLiveAds([]);
    expect(tickerHtml(false, true)).not.toContain('RIPIT');
  });

  it('tells the menu when the board changes, but not on an identical refresh', () => {
    setLiveAds([]);
    let n = 0;
    const off = onLiveAdsChange(() => n++);
    const ad = { text: 'RIPIT .CO', theme: 'gold' as const, until: Date.now() + 60_000 };
    setLiveAds([ad]);
    setLiveAds([{ ...ad }]);
    expect(n).toBe(1);
    setLiveAds([]);
    expect(n).toBe(2);
    off();
    setLiveAds([ad]);
    expect(n).toBe(2);
    setLiveAds([]);
  });
});
