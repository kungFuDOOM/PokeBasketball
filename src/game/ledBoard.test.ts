import { describe, expect, it } from 'vitest';
import { BANNER_ADS, HOUSE_AD, houseAds } from '../data/ads';
import { HOUSE_W, drawLedBoard, type LedHit } from './ledBoard';

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
  it('runs the fixed Slabz house half, then the bookable half', () => {
    const { ctx, texts } = fakeCtx();
    drawLedBoard(ctx, { ...opts, ads: [HOUSE_AD], house: houseAds() });
    const slabz = texts.find((t) => t.text === BANNER_ADS[0].text);
    const yours = texts.find((t) => t.text === 'YOUR AD HERE' && t.x > slabz!.x);
    expect(slabz).toBeDefined();
    expect(yours).toBeDefined();
    // The bookable panel starts after the whole house half.
    expect(yours!.x - slabz!.x).toBeGreaterThan(HOUSE_W - 40);
    expect(texts.some((t) => t.text.includes('OAK LAB') && !t.text.includes('PALLET'))).toBe(true);
  });

  it('puts a booked ad in the bookable half and keeps the Slabz half', () => {
    const { ctx, texts } = fakeCtx();
    drawLedBoard(ctx, { ...opts, ads: [{ text: 'HOLD $PJAM', theme: 'fire' }], house: houseAds() });
    expect(texts.some((t) => t.text === 'HOLD $PJAM')).toBe(true);
    expect(texts.some((t) => t.text === BANNER_ADS[0].text)).toBe(true);
    expect(texts.some((t) => t.text === 'YOUR AD HERE')).toBe(false);
  });

  it('records clickable panels with the final URL and the booking id', () => {
    const { ctx } = fakeCtx();
    const hits: LedHit[] = [];
    const id = '11111111-1111-4111-8111-111111111111';
    drawLedBoard(ctx, { ...opts, hits, ads: [{ text: 'SLABZ .COM', theme: 'gold', url: 'https://slabz.com/ref/POKEJAM', id }, ], house: houseAds() });
    const final = 'https://slabz.com/ref/POKEJAM?utm_source=pokejam&utm_medium=display_ad&utm_campaign=pokejam_ad';
    expect(hits[0]).toMatchObject({ url: final, y0: 2, y1: 18 });
    expect(hits[0].id).toBeUndefined(); // the hardcoded house half has no booking id
    expect(hits[1]).toMatchObject({ url: final, id });
    expect(hits[1].x0).toBeGreaterThanOrEqual(hits[0].x1);
  });

  it('records no hit for an unbooked panel or during hype', () => {
    const { ctx } = fakeCtx();
    const hits: LedHit[] = [];
    drawLedBoard(ctx, { ...opts, hits, ads: [HOUSE_AD] });
    expect(hits).toEqual([]);
    drawLedBoard(ctx, { ...opts, hits, hype: true, ads: [HOUSE_AD], house: houseAds() });
    expect(hits).toEqual([]);
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
