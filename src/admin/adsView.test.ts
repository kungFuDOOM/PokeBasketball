import { describe, expect, it } from 'vitest';
import { AD_RPC, adAction, adConfirm, adsHtml, boardSwitch, isAdBoard, type AdRow } from './adsView';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const row = (over: Partial<AdRow> = {}): AdRow => ({
  id: 'ad-1', text: 'BUY $PJAM', theme: 'gold', wallet: '9wqysMYY4DTcbPjSZpGQU3pF29YUw9w6A1a8XDKVhezh', state: 'paid',
  starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-11-08T00:00:00Z', burn_sig: null, removed_reason: null, banned: false,
  reports: 2, reasons: { scam: 2 }, ...over,
});
const ban = { wallet: 'A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv', reason: 'abusive ads', at: '2026-10-31T00:00:00Z' };

describe('admin Ads tab: devnet / live board switch', () => {
  it('uses the 20261104 RPCs for devnet and the 20261125 live RPCs for live, with the shared ban list', () => {
    expect(AD_RPC.devnet).toEqual({ list: 'pokejam_admin_ads', remove: 'pokejam_admin_ad_remove', bans: 'pokejam_admin_ad_bans', unban: 'pokejam_admin_ad_unban' });
    expect(AD_RPC.live).toEqual({ list: 'pokejam_admin_live_ads', remove: 'pokejam_admin_live_ad_remove', bans: 'pokejam_admin_ad_bans', unban: 'pokejam_admin_ad_unban' });
  });

  it('draws both board buttons and marks the shown one', () => {
    for (const board of ['devnet', 'live'] as const) {
      const html = boardSwitch(board);
      expect(html).toContain('data-board="devnet"');
      expect(html).toContain('data-board="live"');
      expect(html).toMatch(new RegExp(`class="on" data-board="${board}" aria-pressed="true"`));
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    }
    expect(adsHtml([], [], 'live', NOW)).toContain('data-board="live" aria-pressed="true"');
  });

  it('tags every action button with the board it was drawn for', () => {
    const html = adsHtml([row()], [ban], 'live', NOW);
    const acts = html.match(/<button[^>]*data-ad="(remove|ban|unban)"[^>]*>/g)!;
    expect(acts).toHaveLength(3);
    for (const b of acts) expect(b).toContain('data-board="live"');
    expect(html).toContain('>Take down<');
    expect(html).toContain('>Take down + ban<');
    expect(html).toContain('>Lift<');
  });

  it('take down, take down + ban and lift call the right board\'s RPCs', () => {
    expect(adAction('remove', 'live', { id: 'ad-1' }, 'typo')).toEqual({ fn: 'pokejam_admin_live_ad_remove', args: { p_id: 'ad-1', p_reason: 'typo', p_ban: false } });
    expect(adAction('ban', 'live', { id: 'ad-1' }, 'scam')).toEqual({ fn: 'pokejam_admin_live_ad_remove', args: { p_id: 'ad-1', p_reason: 'scam', p_ban: true } });
    expect(adAction('unban', 'live', { wallet: ban.wallet }, '')).toEqual({ fn: 'pokejam_admin_ad_unban', args: { p_wallet: ban.wallet } });
    expect(adAction('remove', 'devnet', { id: 'ad-1' }, 'typo')).toEqual({ fn: 'pokejam_admin_ad_remove', args: { p_id: 'ad-1', p_reason: 'typo', p_ban: false } });
    expect(adAction('ban', 'devnet', {}, 'x')).toBeNull();
    expect(adAction('nope', 'live', { id: 'ad-1' }, '')).toBeNull();
  });

  it('shows how a live ad was paid, and only offers take-down on ads still running', () => {
    const html = adsHtml([row({ pay_method: 'usdc', usdc_sig: 'sig' }), row({ id: 'ad-2', pay_method: 'burn', ends_at: '2026-11-01T06:00:00Z' })], [], 'live', NOW);
    expect(html).toContain('gold · USDC');
    expect(html).toContain('gold · $PJAM burn');
    expect(html.match(/data-ad="remove"/g)).toHaveLength(1);
    expect(html).toContain('<span class="tag">ended</span>');
    // Devnet rows have no pay method and show none.
    expect(adsHtml([row()], [], 'devnet', NOW)).not.toContain(' · ');
  });

  it('warns that it is the live board, and that payments are final', () => {
    expect(adConfirm('remove', 'X', '', 'live')).toMatch(/LIVE board/);
    expect(adConfirm('ban', 'X', '', 'live')).toMatch(/burns or USDC/);
    expect(adConfirm('ban', 'X', '', 'devnet')).not.toMatch(/LIVE|USDC/);
    expect(adConfirm('unban', '', 'W', 'live')).toMatch(/both boards/);
  });

  it('escapes ad text and accepts only known board names', () => {
    expect(adsHtml([row({ text: '<b>"x"</b>' })], [], 'devnet', NOW)).not.toContain('<b>"x"</b>');
    expect(isAdBoard('live')).toBe(true);
    expect(isAdBoard('mainnet')).toBe(false);
    expect(isAdBoard(null)).toBe(false);
  });
});
