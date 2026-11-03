import { describe, expect, it } from 'vitest';
import { shieldEmblemHtml } from './shieldEmblem';

describe('Rank Shield emblem', () => {
  it('is one inline svg in the crest palette, with no shield emoji', () => {
    const h = shieldEmblemHtml();
    expect(h).toContain('<svg');
    expect(h).toContain('class="rk-shield-ico"');
    expect(h).toContain('viewBox="0 0 128 128"');
    expect(h).toContain('width="1em"');
    expect(h).toContain('#120c08');
    expect(h).toContain('#f6c445');
    expect(h).toContain('#ee8434');
    expect(h).not.toMatch(/🛡|🛡️/);
  });
  it('gives every emblem its own gradient ids', () => {
    const a = shieldEmblemHtml();
    const b = shieldEmblemHtml();
    const id = a.match(/id="(rkSh\d+)-body"/)?.[1];
    expect(id).toBeTruthy();
    expect(a).toContain(`url(#${id}-body)`);
    expect(b).not.toContain(`id="${id}-body"`);
  });
});
