import { describe, expect, it } from 'vitest';
import { BANNER_ADS, HOUSE_AD, houseAds } from '../data/ads';
import { HOUSE_W, drawLedBoard } from './ledBoard';

/** A canvas context that records the text drawn and where (8px per character, like the LED font). */
function fakeCtx() {
  const texts: { text: string; x: number }[] = [];
  let tx = 0;
  const ctx = {
    fillStyle: '', font: '', textBaseline: '', globalAlpha: 1,
    fillRect() {}, save() {}, restore() { tx = 0; }, scale() {},
    translate(x: number) { tx = x; },
    measureText: (s: string) => ({ width: s.length * 8 }),
    fillText(text: string, x: number) { texts.push({ text, x: x + tx }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts };
}

const board = 'PALLET TOWN ★ OAK LAB ★ GO';
const opts = { top: 0, width: 480, scroll: 0, t: 0, edge: '#fff', hype: false, text: board };

describe('the courtside LED board', () => {
  it('runs the fixed $PJAM house half, then the bookable half', () => {
    const { ctx, texts } = fakeCtx();
    drawLedBoard(ctx, { ...opts, ads: [HOUSE_AD], house: houseAds() });
    const pjam = texts.find((t) => t.text === BANNER_ADS[0].text);
    const yours = texts.find((t) => t.text === 'YOUR AD HERE' && t.x > pjam!.x);
    expect(pjam).toBeDefined();
    expect(yours).toBeDefined();
    // The bookable panel starts after the whole house half.
    expect(yours!.x - pjam!.x).toBeGreaterThan(HOUSE_W - 40);
    expect(texts.some((t) => t.text.includes('OAK LAB') && !t.text.includes('PALLET'))).toBe(true);
  });

  it('puts a booked ad in the bookable half and keeps the $PJAM half', () => {
    const { ctx, texts } = fakeCtx();
    drawLedBoard(ctx, { ...opts, ads: [{ text: 'HOLD $PJAM', theme: 'fire' }], house: houseAds() });
    expect(texts.some((t) => t.text === 'HOLD $PJAM')).toBe(true);
    expect(texts.some((t) => t.text === BANNER_ADS[0].text)).toBe(true);
    expect(texts.some((t) => t.text === 'YOUR AD HERE')).toBe(false);
  });

  it('shows only BUCKETS! during hype', () => {
    const { ctx, texts } = fakeCtx();
    drawLedBoard(ctx, { ...opts, hype: true, ads: [HOUSE_AD], house: houseAds() });
    expect(texts.every((t) => t.text.includes('BUCKETS!'))).toBe(true);
  });

  it('draws the bookable panel alone when no house panels are passed (the Advertise close-up)', () => {
    const { ctx, texts } = fakeCtx();
    drawLedBoard(ctx, { ...opts, ads: [HOUSE_AD] });
    expect(texts.some((t) => t.text === BANNER_ADS[0].text)).toBe(false);
    expect(texts.some((t) => t.text === 'YOUR AD HERE')).toBe(true);
  });
});
