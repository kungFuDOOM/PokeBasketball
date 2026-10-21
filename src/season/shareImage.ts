// Share card as a PNG, drawn on a canvas. Sprites are same-origin, so the canvas is never tainted.
import { monByDex, spriteUrl } from '../data/pokemon';
import { PLAYOFF_TEXT } from './sim';
import { teamGrade } from './grade';
import type { SharedTeam } from './share';

const SIZE = 1080;

function load(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;

/** Largest font size (up to `px`) at which `text` fits in `max` pixels. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number, px: number, font: string): number {
  let size = px;
  do ctx.font = `800 ${size}px ${font}`; while (ctx.measureText(text).width > max && (size -= 4) > 24);
  return size;
}

export async function renderShareCard(t: SharedTeam): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d')!;
  const sans = "'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif";
  const pixel = "'Press Start 2P', ui-monospace, monospace";
  const { grade } = teamGrade(t.dex.map((d) => monByDex(d)));

  const bg = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  bg.addColorStop(0, t.color2);
  bg.addColorStop(0.55, '#0a0d1f');
  bg.addColorStop(1, '#0a0d1f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = t.color;
  ctx.fillRect(0, 0, SIZE, 18);
  ctx.fillRect(0, SIZE - 18, SIZE, 18);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffcb05';
  ctx.font = `30px ${pixel}`;
  ctx.fillText('POKé JAM', 56, 100);
  ctx.fillStyle = '#9aa0c8';
  ctx.font = `700 34px ${sans}`;
  ctx.textAlign = 'right';
  ctx.fillText('SEASON DRAFT', SIZE - 56, 98);
  ctx.textAlign = 'left';

  ctx.fillStyle = '#f2f0e6';
  ctx.font = `800 ${fit(ctx, t.name.toUpperCase(), SIZE - 112, 120, `${sans}`)}px ${sans}`;
  ctx.fillText(t.name.toUpperCase(), 56, 220);

  // Sprites: two rows of five on soft tiles.
  const imgs = await Promise.all(t.dex.map((d) => load(spriteUrl(d))));
  const tile = 176;
  const gap = 20;
  const x0 = (SIZE - (5 * tile + 4 * gap)) / 2;
  imgs.forEach((img, i) => {
    const x = x0 + (i % 5) * (tile + gap);
    const y = 260 + Math.floor(i / 5) * (tile + gap);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(x, y, tile, tile, 18);
    ctx.fill();
    ctx.stroke();
    if (img) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, x + 14, y + 4, tile - 28, tile - 28);
    }
    ctx.fillStyle = '#f2f0e6';
    ctx.font = `700 22px ${sans}`;
    ctx.textAlign = 'center';
    ctx.fillText(monByDex(t.dex[i]).name.toUpperCase(), x + tile / 2, y + tile - 8, tile - 12);
    ctx.textAlign = 'left';
  });

  // Result strip.
  const top = 260 + 2 * tile + gap + 50;
  ctx.fillStyle = '#ffcb05';
  ctx.font = `120px ${pixel}`;
  ctx.fillText(`${t.w}-${t.l}`, 56, top + 100);
  ctx.fillStyle = '#f2f0e6';
  ctx.font = `800 52px ${sans}`;
  ctx.fillText(`${ordinal(t.rank)} of ${t.teams}${t.seed ? ` · #${t.seed} seed` : ''}`, 56, top + 170);
  ctx.fillStyle = t.playoff === 'champion' ? '#ffcb05' : '#9aa0c8';
  ctx.font = `800 52px ${sans}`;
  ctx.fillText(PLAYOFF_TEXT[t.playoff].toUpperCase(), 56, top + 230);

  // Grade badge.
  ctx.fillStyle = t.color;
  ctx.beginPath();
  ctx.roundRect(SIZE - 56 - 250, top + 10, 250, 250, 28);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = `700 34px ${sans}`;
  ctx.fillText('DRAFT GRADE', SIZE - 56 - 125, top + 60);
  ctx.font = `110px ${pixel}`;
  ctx.fillText(grade, SIZE - 56 - 125, top + 200);

  ctx.fillStyle = '#9aa0c8';
  ctx.font = `700 34px ${sans}`;
  ctx.fillText('pokejam.xyz', SIZE / 2, SIZE - 44);
  ctx.textAlign = 'left';
  return c;
}

const toBlob = (c: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'));

export function fileName(t: SharedTeam): string {
  return `pokejam-${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team'}.png`;
}

/** Native share sheet with the image when the device supports it; otherwise a download. Returns what happened. */
export async function shareOrDownload(c: HTMLCanvasElement, t: SharedTeam): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const blob = await toBlob(c);
  const name = fileName(t);
  if (blob && typeof File !== 'undefined' && navigator.canShare && navigator.share) {
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Poké Jam', text: `${t.name} went ${t.w}-${t.l} in Poké Jam` });
        return 'shared';
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return 'cancelled';
      }
    }
  }
  await download(c, name, blob);
  return 'downloaded';
}

export async function download(c: HTMLCanvasElement, name: string, blob?: Blob | null) {
  const b = blob ?? (await toBlob(c));
  const a = document.createElement('a');
  a.download = name;
  a.href = b ? URL.createObjectURL(b) : c.toDataURL('image/png');
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (b) setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
