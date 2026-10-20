import { spriteUrl, type Mon } from '../data/pokemon';

export interface Sprite {
  img: CanvasImageSource;
  w: number;
  h: number;
}

const cache = new Map<string, Sprite | null>();
const pending = new Map<string, Promise<Sprite | null>>();

/** Trims transparent padding so the sprite's feet sit on the floor. */
function crop(img: HTMLImageElement): Sprite {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  try {
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 20) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return { img, w: img.naturalWidth, h: img.naturalHeight };
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return { img: out, w: out.width, h: out.height };
  } catch {
    // Tainted canvas (no CORS): fall back to the raw image.
    return { img, w: img.naturalWidth, h: img.naturalHeight };
  }
}

function load(key: string, url: string): Promise<Sprite | null> {
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  const existing = pending.get(key);
  if (existing) return existing;
  const p = new Promise<Sprite | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const s = crop(img);
      cache.set(key, s);
      resolve(s);
    };
    img.onerror = () => {
      cache.set(key, null);
      resolve(null);
    };
    img.src = url;
  });
  pending.set(key, p);
  return p;
}

export function preload(mons: Mon[]): Promise<unknown> {
  return Promise.all(mons.flatMap((m) => [
    load('f' + m.dex, spriteUrl(m.dex)),
    load('b' + m.dex, spriteUrl(m.dex, true)),
  ]));
}

export function getSprite(dex: number, back: boolean): Sprite | null {
  if (back) {
    const b = cache.get('b' + dex);
    if (b) return b;
  }
  return cache.get('f' + dex) ?? null;
}
