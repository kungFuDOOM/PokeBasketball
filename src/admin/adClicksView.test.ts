import { describe, expect, it } from 'vitest';
import { adClicksError, adClicksHtml } from './adClicksView';

describe('admin Ad clicks panel', () => {
  it('shows total, 24h and 7d per domain, with a totals row', () => {
    const html = adClicksHtml([
      { domain: 'ripit.co', ads: ['RIPIT .CO'], total: 12, last_24h: 3, last_7d: 9 },
      { domain: 'foo.gg', ads: ['FOO.GG', 'PLAY FOO.GG'], total: 2, last_24h: 0, last_7d: 1 },
    ]);
    expect(html).toContain('<strong>ripit.co</strong>');
    expect(html).toMatch(/<td class="num">12<\/td><td class="num">3<\/td><td class="num">9<\/td>/);
    expect(html).toContain('FOO.GG, PLAY FOO.GG');
    expect(html).toMatch(/<strong>All<\/strong>.*<td class="num">14<\/td><td class="num">3<\/td><td class="num">10<\/td>/s);
  });
  it('says so when there are no clicks, and escapes anything from the server', () => {
    expect(adClicksHtml([])).toContain('No clicks on paid ads yet.');
    const html = adClicksHtml([{ domain: '<img src=x>', ads: ['"><b>'], total: 1, last_24h: 1, last_7d: 1 }]);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('"><b>');
    expect(adClicksError('<x>')).not.toContain('<x>');
  });
});
