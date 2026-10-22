// Share card as a PNG, drawn on a canvas. Sprites are same-origin, so the canvas is never tainted.
import { monByDex, spriteUrl, type Pos } from '../data/pokemon';
import { bestLineup } from '../game/game';
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

  // Sprites: two rows of five on soft tiles, the starting five (by position) on top.
  const lineup = bestLineup(t.dex.map((d) => monByDex(d)));
  const order = [...lineup.starters, ...lineup.bench].map((m) => m.dex);
  const imgs = await Promise.all(order.map((d) => load(spriteUrl(d))));
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
    ctx.fillText(monByDex(order[i]).name.toUpperCase(), x + tile / 2, y + tile - 8, tile - 12);
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
  if (t.allStars) {
    ctx.fillStyle = '#ffcb05';
    ctx.font = `800 46px ${sans}`;
    ctx.fillText(`★ ${t.allStars} ALL-STAR${t.allStars > 1 ? 'S' : ''}`, 56, top + 290);
  }

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

/** Where each lineup slot stands on the card's half court (fractions of the court box, basket at the top). */
const SPOT: Record<Pos, [number, number]> = { PG: [0.5, 0.8], SG: [0.83, 0.55], SF: [0.17, 0.55], PF: [0.68, 0.24], C: [0.32, 0.24] };

/**
 * Draft-complete share card: team name in its color, grade and Team OVR, the starting five on a half court with
 * their slot labels, and the bench in a row. Only our sprites; the court is plain lines.
 */
export async function renderDraftCard(t: SharedTeam): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d')!;
  const sans = "'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif";
  const pixel = "'Press Start 2P', ui-monospace, monospace";
  const mons = t.dex.map((d) => monByDex(d));
  const { starters, bench, slots } = bestLineup(mons);
  const { grade, ovr } = teamGrade(mons);
  const [simg, bimg] = await Promise.all([Promise.all(starters.map((m) => load(spriteUrl(m.dex)))), Promise.all(bench.map((m) => load(spriteUrl(m.dex))))]);

  const bg = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  bg.addColorStop(0, t.color2);
  bg.addColorStop(0.6, '#0a0d1f');
  bg.addColorStop(1, '#0a0d1f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = t.color;
  ctx.fillRect(0, 0, SIZE, 18);
  ctx.fillRect(0, SIZE - 18, SIZE, 18);

  ctx.fillStyle = '#ffcb05';
  ctx.font = `30px ${pixel}`;
  ctx.fillText('POKé JAM', 56, 92);
  ctx.fillStyle = '#9aa0c8';
  ctx.font = `700 34px ${sans}`;
  ctx.textAlign = 'right';
  ctx.fillText('DRAFT COMPLETE', SIZE - 56, 90);
  ctx.textAlign = 'left';

  // Name in the team color (with a dark edge so any color reads on the dark card).
  const name = t.name.toUpperCase();
  ctx.font = `800 ${fit(ctx, name, SIZE - 112 - 300, 104, sans)}px ${sans}`;
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeText(name, 56, 196);
  ctx.fillStyle = t.color;
  ctx.fillText(name, 56, 196);

  // Grade and OVR, top right.
  const bx = SIZE - 56 - 280;
  ctx.fillStyle = t.color;
  ctx.beginPath();
  ctx.roundRect(bx, 118, 132, 132, 20);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.roundRect(bx + 148, 118, 132, 132, 20);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = `700 24px ${sans}`;
  ctx.fillText('GRADE', bx + 66, 152);
  ctx.fillText('TEAM OVR', bx + 214, 152);
  ctx.font = `52px ${pixel}`;
  ctx.fillText(grade, bx + 66, 226);
  ctx.fillStyle = '#ffcb05';
  ctx.fillText(String(ovr), bx + 214, 226);
  ctx.textAlign = 'left';

  // Half court: wood floor, key and three-point arc as plain lines.
  const cx = 110, cy = 280, cw = SIZE - 220, ch = bench.length ? 520 : 640;
  const wood = ctx.createLinearGradient(0, cy, 0, cy + ch);
  wood.addColorStop(0, '#c99a5b');
  wood.addColorStop(1, '#a87a42');
  ctx.fillStyle = wood;
  ctx.beginPath();
  ctx.roundRect(cx, cy, cw, ch, 22);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(cx + cw / 2 - 110, cy, 220, ch * 0.42);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + cw / 2, cy + 20, cw * 0.4, 0.08 * Math.PI, 0.92 * Math.PI);
  ctx.stroke();

  ctx.imageSmoothingEnabled = false;
  const sz = 150;
  starters.forEach((m, k) => {
    const [fx, fy] = SPOT[slots[k]];
    const x = cx + fx * cw;
    const y = cy + fy * ch;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(x, y + sz * 0.42, sz * 0.36, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    const img = simg[k];
    if (img) ctx.drawImage(img, x - sz / 2, y - sz / 2, sz, sz);
    // Slot chip and name under the sprite.
    ctx.fillStyle = t.color;
    ctx.beginPath();
    ctx.roundRect(x - 34, y + sz / 2 - 4, 68, 34, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = `800 26px ${sans}`;
    ctx.fillText(slots[k], x, y + sz / 2 + 22);
    ctx.font = `800 26px ${sans}`;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    const label = m.name.toUpperCase();
    ctx.strokeText(label, x, y + sz / 2 + 58, 220);
    ctx.fillText(label, x, y + sz / 2 + 58, 220);
    ctx.textAlign = 'left';
  });

  if (bench.length) {
    const top = cy + ch + 30;
    ctx.fillStyle = '#9aa0c8';
    ctx.font = `700 28px ${sans}`;
    ctx.fillText('BENCH', 56, top + 24);
    const tile = 132, gap = 18;
    const x0 = (SIZE - (bench.length * tile + (bench.length - 1) * gap)) / 2;
    bench.forEach((m, i) => {
      const x = x0 + i * (tile + gap);
      const y = top + 36;
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x, y, tile, tile, 14);
      ctx.fill();
      ctx.stroke();
      const img = bimg[i];
      if (img) ctx.drawImage(img, x + 10, y + 2, tile - 20, tile - 20);
      ctx.fillStyle = '#c9cce6';
      ctx.font = `700 20px ${sans}`;
      ctx.textAlign = 'center';
      ctx.fillText(`${m.pos} · ${m.name.toUpperCase()}`, x + tile / 2, y + tile - 8, tile - 10);
      ctx.textAlign = 'left';
    });
  }

  ctx.fillStyle = '#9aa0c8';
  ctx.font = `700 34px ${sans}`;
  ctx.textAlign = 'center';
  ctx.fillText('pokejam.xyz', SIZE / 2, SIZE - 40);
  ctx.textAlign = 'left';
  return c;
}

/** The right card for a shared team: the season card, or the draft card when no season was played. */
export const renderCard = (t: SharedTeam) => (t.noRecord ? renderDraftCard(t) : renderShareCard(t));

const toBlob = (c: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'));

export function fileName(t: SharedTeam): string {
  return `pokejam-${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team'}.png`;
}

/** Native share sheet with the image when the device supports it; otherwise a download. Returns what happened. */
/** The message that goes with a shared team: record, grade and the #s= link. */
export function shareText(t: SharedTeam, url: string): string {
  const { grade, ovr } = teamGrade(t.dex.map((d) => monByDex(d)));
  if (t.noRecord) return `My PokeJam draft: ${t.name}, grade ${grade}, ${ovr} OVR ${url}`;
  return `My PokeJam team went ${t.w}-${t.l}, grade ${grade} ${url}`;
}

export const toPngBlob = (c: HTMLCanvasElement) => toBlob(c);

/**
 * "Share my team": the phone share sheet with the image and the link together. Where the share sheet can't take
 * files (most desktops), the image downloads and the link goes to the clipboard instead.
 * Pass a pre-rendered blob so the share call stays inside the tap (Safari drops it otherwise).
 */
export async function shareTeam(c: HTMLCanvasElement, blob: Blob | null, t: SharedTeam, url: string): Promise<'shared' | 'cancelled' | 'saved+copied' | 'saved'> {
  const name = fileName(t);
  const text = shareText(t, url);
  if (blob && typeof File !== 'undefined' && navigator.canShare && navigator.share) {
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare({ files: [file], text })) {
      try {
        await navigator.share({ files: [file], title: 'Poké Jam', text });
        return 'shared';
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return 'cancelled';
      }
    }
  }
  await download(c, name, blob);
  try {
    await navigator.clipboard.writeText(url);
    return 'saved+copied';
  } catch {
    return 'saved';
  }
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
