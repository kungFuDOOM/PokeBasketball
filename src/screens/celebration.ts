// The on-court celebration that opens the championship cutscene: the champion's players jump, bump and hug on their
// home floor while the Finals MVP lifts the trophy. Court, Pokémon and trophy are the game's own art; only the
// motion, confetti, streamers and camera flashes are code.
import { monOf, venueOf, type FTeam, type Franchise } from '../franchise/league';
import { celebrationCast } from '../franchise/moments';
import { Renderer } from '../game/render';
import { getSprite, preload } from '../game/sprites';
import { TROPHY_IMG } from '../ui/trophy';

export function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** How long the scene plays before the title card slides in. */
export const SCENE_MS = 6200;
export const SCENE_MS_CALM = 2200;

/** The court spot (feet from centre court, and depth) for each crew member, best player first. */
interface Slot { dx: number; y: number; mate?: number }
const CENTRE_X = 47;
const MVP_SPOT = { dx: 0, y: 30 };
const SLOTS: Slot[] = [
  { dx: -11, y: 33, mate: 2 }, { dx: 11, y: 33, mate: 3 }, { dx: -21, y: 33, mate: 0 }, { dx: 21, y: 33, mate: 1 },
  { dx: -5, y: 41 }, { dx: 6, y: 41 }, { dx: 0, y: 23 },
];

interface Actor {
  dex: number; size: number; x: number; y: number;
  freq: number; phase: number; amp: number; face: number; mate: number; side: number;
}

/** On-screen height of a Pokémon in feet: a little bigger than in play so the party reads on a phone. */
const ft = (a: { size: number }) => (2.3 + 1.7 * a.size) * 1.25;
const ease =(k: number) => { const c = k < 0 ? 0 : k > 1 ? 1 : k; return c * c * (3 - 2 * c); };

/** Pair choreography: 0..1 how close the two are (1 = chest bump), and where in the cycle. */
function bumpAt(t: number, side: number) {
  const P = 2.6;
  const u = ((t + side * 1.3) % P) / P;
  const k = u < 0.45 ? ease(u / 0.45) : u < 0.6 ? 1 : 1 - ease((u - 0.6) / 0.4);
  return { k, u };
}

export function startCelebration(host: HTMLElement, f: Franchise, champ: FTeam): () => void {
  const canvas = host.querySelector<HTMLCanvasElement>('canvas.cel-canvas');
  const zoomEl = host.querySelector<HTMLElement>('.cel-zoom');
  if (!canvas || !zoomEl) return () => {};
  const calm = reducedMotion();
  const cast = celebrationCast(f, champ);
  const lead = cast.mvp || cast.crew[0] || null;
  const crew = cast.mvp ? cast.crew : cast.crew.slice(1);
  const rd = new Renderer(canvas);
  const court = venueOf(f, f.teams.indexOf(champ));

  const mk = (uid: string, spot: { dx: number; y: number }, i: number, mate = -1): Actor => {
    const m = monOf(f, uid);
    return {
      dex: m.dex, size: m.size, x: CENTRE_X + spot.dx, y: spot.y,
      freq: 0.85 + ((i * 37) % 11) / 20, phase: (i * 0.37) % 1, amp: 1.5 + ((i * 13) % 7) / 8,
      face: spot.dx === 0 ? (i % 2 ? 1 : -1) : spot.dx < 0 ? 1 : -1, mate, side: spot.dx < 0 ? 0 : 1,
    };
  };
  const crewActors = crew.slice(0, SLOTS.length).map((u, i) => mk(u, SLOTS[i], i + 1, SLOTS[i].mate !== undefined && SLOTS[i].mate! < crew.length ? SLOTS[i].mate! : -1));
  const star = lead ? mk(lead, MVP_SPOT, 0) : null;
  const actors = star ? [star].concat(crewActors) : crewActors;
  if (star) star.amp = 1.1;
  preload((lead ? [lead] : []).concat(crew.slice(0, SLOTS.length)).map((u) => monOf(f, u)));

  const trophy = new Image();
  trophy.src = TROPHY_IMG;

  // Steps the trophy down in halves to the size it is drawn at, so it keeps its edges instead of turning to mush.
  let cached: HTMLCanvasElement | null = null;
  const scaled = (th: number, tw: number): HTMLCanvasElement => {
    if (cached && cached.height === th) return cached;
    let cur: CanvasImageSource = trophy;
    let cw = trophy.naturalWidth;
    let ch = trophy.naturalHeight;
    let out = document.createElement('canvas');
    while (true) {
      const nw = ch / 2 > th ? Math.round(cw / 2) : tw;
      const nh = ch / 2 > th ? Math.round(ch / 2) : th;
      out = document.createElement('canvas');
      out.width = nw;
      out.height = nh;
      const g = out.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      g.drawImage(cur, 0, 0, nw, nh);
      cur = out; cw = nw; ch = nh;
      if (nh === th) break;
    }
    cached = out;
    return out;
  };
  const ctx = canvas.getContext('2d')!;
  const T0 = performance.now();
  let last = T0;
  let drawn = -1;
  let raf = 0;

  /** x, z, and facing for one actor at time t. */
  const pose = (a: Actor, t: number) => {
    let x = a.x;
    let z = 0;
    let face = a.face;
    if (calm) return { x, z, face };
    if (a.mate >= 0) {
      const b = crewActors[a.mate];
      const { k, u } = bumpAt(t, a.side);
      const mid = (a.x + b.x) / 2;
      x = mid + (a.x - mid) * (1 - 0.85 * k);
      z = 2 * Math.sin(Math.PI * Math.min(1, Math.max(0, (u - 0.45) / 0.3)));
      face = b.x > a.x ? -1 : 1;
    } else {
      z = a.amp * Math.abs(Math.sin(Math.PI * (a.freq * t + a.phase)));
    }
    return { x, z, face };
  };

  const draw = (t: number, dt: number) => {
    rd.backdrop(court, dt, !calm);
    const items: { y: number; draw: () => void }[] = [];
    actors.forEach((a, idx) => {
      const p = pose(a, calm ? 0.55 : t);
      const foot = rd.view(p.x, a.y);
      const spr = getSprite(a.dex, false);
      items.push({
        y: a.y,
        draw: () => {
          ctx.fillStyle = 'rgba(0,0,0,0.32)';
          ctx.beginPath();
          ctx.ellipse(foot.x, foot.y, 1.1 * a.size * foot.s * (1 - Math.min(0.3, p.z / 8)), 1.1 * a.size * foot.s * 0.22, 0, 0, Math.PI * 2);
          ctx.fill();
          if (!spr) return;
          const pos = rd.view(p.x, a.y, p.z);
          const px = ft(a) * pos.s;
          const k = px / Math.max(spr.w, spr.h);
          const squash = p.z < 0.15 ? 0.94 : 1.04;
          ctx.save();
          ctx.translate(Math.round(pos.x), Math.round(pos.y));
          ctx.scale((p.face === 1 ? -1 : 1) * (2 - squash), squash);
          ctx.drawImage(spr.img, Math.round(-spr.w * k / 2), Math.round(-spr.h * k), Math.round(spr.w * k), Math.round(spr.h * k));
          ctx.restore();
        },
      });
      if (idx === 0 && star) {
        // The trophy goes up over the MVP's head, a little behind the front of the sprite order so it never hides the face.
        items.push({
          y: a.y + 0.01,
          draw: () => {
            if (!trophy.complete || !trophy.naturalWidth) return;
            const hgt = ft(a) * rd.view(p.x, a.y).s;
            const raise = calm ? 1 : ease(t / 1.3);
            const top = rd.view(p.x, a.y, p.z + ft(a) * (0.45 + 0.6 * raise));
            const th = Math.round(hgt * 1.3);
            const tw = Math.round(th * (trophy.naturalWidth / trophy.naturalHeight));
            const pic = scaled(th, tw);
            const tx = top.x;
            const ty = top.y + (calm ? 0 : Math.sin(t * 4) * 1);
            const glow = ctx.createRadialGradient(tx, ty - th * 0.5, 2, tx, ty - th * 0.5, th * 1.1);
            glow.addColorStop(0, 'rgba(255,214,90,0.55)');
            glow.addColorStop(1, 'rgba(255,214,90,0)');
            ctx.fillStyle = glow;
            ctx.fillRect(tx - th * 1.2, ty - th * 1.7, th * 2.4, th * 2.4);
            ctx.drawImage(pic, Math.round(tx - tw / 2), Math.round(ty - th));
          },
        });
      }
    });
    items.sort((a, b) => a.y - b.y);
    items.forEach((it) => it.draw());
    // A star pops where each pair meets.
    if (!calm) {
      for (let i = 0; i < crewActors.length; i++) {
        const a = crewActors[i];
        if (a.mate < 0 || a.x > crewActors[a.mate].x) continue;
        const { u } = bumpAt(t, a.side);
        if (u < 0.45 || u > 0.75) continue;
        const at = rd.view((a.x + crewActors[a.mate].x) / 2, a.y, ft(a) * 0.8);
        const r = (u - 0.45) / 0.3;
        ctx.strokeStyle = `rgba(255,236,150,${1 - r})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let s = 0; s < 8; s++) {
          const ang = (s * Math.PI) / 4;
          ctx.moveTo(at.x + Math.cos(ang) * (5 + r * 4), at.y + Math.sin(ang) * (5 + r * 4));
          ctx.lineTo(at.x + Math.cos(ang) * (9 + r * 9), at.y + Math.sin(ang) * (9 + r * 9));
        }
        ctx.stroke();
      }
    }
  };

  const frame = (now: number) => {
    const t = (now - T0) / 1000;
    if (!calm) {
      // Slow push-in with a gentle drift: transform only, so it stays smooth on phones.
      const z = 1 + 0.22 * ease(t / 7);
      zoomEl.style.transform = `translate3d(${(-1.2 + 2.4 * ease(t / 7)).toFixed(2)}%,0,0) scale(${z.toFixed(4)})`;
    }
    // The 480x270 canvas redraws at ~30 fps; the camera move above runs every frame.
    const step = Math.floor(t * 30);
    if (step !== drawn) {
      drawn = step;
      draw(t, Math.min(0.1, (now - last) / 1000));
      last = now;
    }
    raf = requestAnimationFrame(frame);
  };
  if (calm) {
    // A still scene: draw it a few times while the sprites arrive, then stop.
    const settle = () => { draw(0, 0.016); };
    settle();
    const timers = [250, 700, 1500].map((ms) => window.setTimeout(settle, ms));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
