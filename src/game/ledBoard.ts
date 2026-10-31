import { AD_TAG, AD_THEMES, boardAfterAd, type BannerAd, type BoardAd } from '../data/ads';

export interface LedBoardOptions {
  /** Top of the 20px board. */
  top: number;
  /** Visible width; the board runs 4px past both edges so screen shake never uncovers the ends. */
  width: number;
  /** How far the ticker has scrolled, in pixels. */
  scroll: number;
  /** Seconds, for the pulse and the hype flash. */
  t: number;
  /** The court's board colour (frame and text). */
  edge: string;
  /** After a bucket the board flashes BUCKETS! instead of the ads. */
  hype: boolean;
  /** The court's own board text; its first segment is where the ad panel goes. */
  text: string;
  /** Ads shown in turn, one per repeat of the ticker. */
  ads: BoardAd[];
  /**
   * Fixed house panels (the $PJAM half) drawn before the booked ad in every repeat, each HOUSE_W wide with its text
   * condensed to fit. Omit for the Advertise page's close-up of the bookable panel alone.
   */
  house?: BannerAd[];
}

const LEAD = 4, PAD = 6, GAP = 4, TAG_PAD = 3;
/** Width of one fixed house panel (main's half width before the bookable panel). */
export const HOUSE_W = 190;
const HOUSE_PAD = 4;

function drawHousePanel(ctx: CanvasRenderingContext2D, a: BannerAd, bx: number, top: number, base: number, pulse: number) {
  const tx = bx + 2 + HOUSE_PAD;
  const tagW = Math.ceil(ctx.measureText(a.tag).width) + TAG_PAD * 2;
  const room = HOUSE_W - 4 - HOUSE_PAD * 2 - tagW - GAP;
  const textW = Math.ceil(ctx.measureText(a.text).width) || 1;
  const k = Math.min(1, room / textW);
  ctx.globalAlpha = pulse;
  ctx.fillStyle = a.border;
  ctx.fillRect(bx, top + 2, HOUSE_W, 16);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#05060f';
  ctx.fillRect(bx + 1, top + 3, HOUSE_W - 2, 14);
  ctx.fillStyle = a.bg;
  ctx.fillRect(bx + 2, top + 4, HOUSE_W - 4, 12);
  ctx.fillStyle = a.tagBg;
  ctx.fillRect(tx, top + 5, tagW, 10);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(a.tag, tx + TAG_PAD, base);
  ctx.fillStyle = a.color;
  ctx.save();
  ctx.translate(tx + tagW + GAP + Math.floor((room - textW * k) / 2), base);
  ctx.scale(k, 1);
  ctx.fillText(a.text, 0, 0);
  ctx.restore();
}

/**
 * The courtside LED ad board. Each repeat of the ticker is [lead][house panels][ad block][board text]; with several
 * ads, each repeat shows the next one in the bookable block, so they take turns. Whole-pixel layout, so the repeats join cleanly.
 */
export function drawLedBoard(ctx: CanvasRenderingContext2D, o: LedBoardOptions) {
  const { top, width } = o;
  ctx.fillStyle = '#05060f';
  ctx.fillRect(-4, top, width + 8, 20);
  const color = o.hype && Math.floor(o.t * 6) % 2 ? '#ffffff' : o.edge;
  ctx.fillStyle = o.edge;
  ctx.fillRect(-4, top, width + 8, 1);
  ctx.fillRect(-4, top + 19, width + 8, 1);
  ctx.font = '8px "Press Start 2P", monospace';
  ctx.textBaseline = 'alphabetic';
  const base = top + 13;
  const ads = o.hype ? [] : o.ads;
  const house = o.hype ? [] : (o.house ?? []);
  const houseW = house.length * HOUSE_W;
  const msg = o.hype ? '  BUCKETS!  ★  BUCKETS!  ★ ' : ads.length || house.length ? `  ★ ${boardAfterAd(o.text)}  ★ ` : `  ${o.text}  ★ `;
  const msgW = Math.ceil(ctx.measureText(msg).width || 400);
  const tagW = Math.ceil(ctx.measureText(AD_TAG).width) + TAG_PAD * 2;
  const segs = (ads.length ? ads : [null]).map((ad) => {
    const adW = ad ? Math.ceil(ctx.measureText(ad.text).width) : 0;
    const blockW = ad ? 4 + PAD * 2 + tagW + GAP + adW : 0;
    const lead = ad || houseW ? LEAD + houseW : 0;
    return { ad, blockW, lead, w: lead + blockW + msgW };
  });
  const cycle = segs.reduce((s, x) => s + x.w, 0);
  const pulse = 0.8 + 0.2 * (Math.floor(o.t * 2) % 2);
  let x = -Math.floor(((o.scroll % cycle) + cycle) % cycle) - cycle;
  for (let i = 0; x < width + 4; i++) {
    const s = segs[i % segs.length];
    house.forEach((a, j) => drawHousePanel(ctx, a, x + LEAD + j * HOUSE_W, top, base, pulse));
    if (s.ad) {
      const th = AD_THEMES[s.ad.theme];
      const bx = x + s.lead;
      const tx = bx + 2 + PAD;
      ctx.globalAlpha = pulse;
      ctx.fillStyle = th.border;
      ctx.fillRect(bx, top + 2, s.blockW, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#05060f';
      ctx.fillRect(bx + 1, top + 3, s.blockW - 2, 14);
      ctx.fillStyle = th.bg;
      ctx.fillRect(bx + 2, top + 4, s.blockW - 4, 12);
      ctx.fillStyle = th.tagBg;
      ctx.fillRect(tx, top + 5, tagW, 10);
      ctx.fillStyle = th.tagColor;
      ctx.fillText(AD_TAG, tx + TAG_PAD, base);
      ctx.fillStyle = th.color;
      ctx.fillText(s.ad.text, tx + tagW + GAP, base);
    }
    ctx.fillStyle = color;
    ctx.fillText(msg, x + s.lead + s.blockW, base);
    x += s.w;
  }
}
