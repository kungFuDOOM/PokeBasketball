// Original gold pixel crown drawn over the Kabuto sprite in code (public/sprites is gitignored, so no baked PNG).

/**
 * Hand-drawn crown, one char per pixel: '.' empty, 'o' outline (the sprite's own outline colour), 'g' gold,
 * 'd' dark gold shade, 'h' highlight. Three points, a gold band and a shaded base row.
 */
export const CROWN_PIXELS: readonly string[] = [
  '.o...o...o.',
  'ogo.ogo.ogo',
  'oggogggoggo',
  'oghgggggggo',
  'odddddddddo',
  'ooooooooooo',
];

export const CROWN_COLORS: Readonly<Record<string, string>> = {
  g: '#f8c818',
  d: '#c08010',
  h: '#fff6b0',
};

const ALPHA_MIN = 16;

/** Top-most opaque row and the centre column of its opaque run in RGBA `data` (w x h), or null if empty. */
export function topAnchor(data: ArrayLike<number>, w: number, h: number): { row: number; cx: number; outline: string } | null {
  for (let y = 0; y < h; y++) {
    let x0 = -1, x1 = -1;
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] >= ALPHA_MIN) {
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    }
    if (x0 >= 0) {
      const i = (y * w + x0) * 4;
      const outline = `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`;
      return { row: y, cx: (x0 + x1 + 1) / 2, outline };
    }
  }
  return null;
}

/**
 * Draw the crown on a sprite canvas (w x h, sprite already drawn): integer-scaled with the sprite size
 * (1x for the 96 px sprites), centred on the top of the shell, its base row nested one sprite pixel into it.
 */
export function drawCrown(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const a = topAnchor(ctx.getImageData(0, 0, w, h).data, w, h);
  if (!a) return;
  const s = Math.max(1, Math.floor(w / 96));
  const cw = CROWN_PIXELS[0].length, ch = CROWN_PIXELS.length;
  const left = Math.round(a.cx - (cw * s) / 2);
  const top = Math.max(0, a.row + s - ch * s);
  ctx.imageSmoothingEnabled = false;
  CROWN_PIXELS.forEach((line, y) => {
    for (let x = 0; x < cw; x++) {
      const c = line[x];
      if (c === '.') continue;
      ctx.fillStyle = c === 'o' ? a.outline : CROWN_COLORS[c];
      ctx.fillRect(left + x * s, top + y * s, s, s);
    }
  });
}

const cache = new Map<string, Promise<string>>();

/** Resolves to a data URL of the sprite with the crown on it; cached per URL; the plain URL on any error. */
export function crownedSpriteUrl(spriteUrl: string): Promise<string> {
  let p = cache.get(spriteUrl);
  if (!p) {
    p = render(spriteUrl).catch(() => spriteUrl);
    cache.set(spriteUrl, p);
  }
  return p;
}

function render(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return reject(new Error('no DOM'));
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx || !c.width) throw new Error('no canvas');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);
        drawCrown(ctx, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error(`sprite failed: ${url}`));
    img.src = url;
  });
}
