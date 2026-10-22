import type { Game } from './game';
import { HOOP_Y, backDir, clamp, dist, emptyIntent, hoopX, isThree, type Intent, type Player, type TeamId } from './types';

/** Floor spots per slot as [feet back from the hoop toward half court, y]. */
const SPOTS: [number, number][] = [
  [25, 25], // PG: top of the key
  [20, 7], // SG: right wing (far side)
  [20, 43], // SF: left wing (near side)
  [13, 35], // PF: elbow
  [6, 16], // C: low block
];

function moveTo(p: Player, it: Intent, tx: number, ty: number, turboDist = 14) {
  const dx = tx - p.x;
  const dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.6) return;
  const s = Math.min(1, d / 2.5);
  it.mx = (dx / d) * s;
  it.my = (dy / d) * s;
  it.turbo = d > turboDist && p.turbo > 0.3;
}

function inFrontcourt(x: number, team: TeamId): boolean {
  return (x - 47) * -backDir(team) > 0;
}

/** Distance from point (px,py) to segment (ax,ay)-(bx,by). */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function think(g: Game, p: Player, dt: number): Intent {
  const it = emptyIntent();
  const ai = p.ai;
  ai.think -= dt;
  ai.jitterT -= dt;
  ai.cutT -= dt;
  if (p.state === 'stun' || p.state === 'dunk' || p.state === 'hang') return it;
  if (g.phase === 'tip' || g.phase === 'break') return it;

  if (ai.jumpIn >= 0) {
    ai.jumpIn -= dt;
    if (ai.jumpIn < 0 && p.z === 0) it.shoot = true;
  }

  const b = g.ball;
  if (b.owner === p) return onBall(g, p, it);
  if (g.phase === 'dead') {
    // The team inbounding sends its nearest player to the ball; everyone else sets up.
    if (p.team === g.offense) {
      const nearest = closestToBall(g, p.team);
      if (nearest === p) moveTo(p, it, b.x, b.y);
      else offBall(g, p, it);
    } else defend(g, p, it, dt);
    return it;
  }
  if (b.mode === 'loose' || b.mode === 'shot') {
    chaseBoard(g, p, it, dt);
    return it;
  }
  if (b.mode === 'pass' && b.pass?.to === p) {
    moveTo(p, it, (b.x + p.x) / 2, (b.y + p.y) / 2);
    return it;
  }
  if (p.team === g.offense) offBall(g, p, it);
  else defend(g, p, it, dt);
  return it;
}

function closestToBall(g: Game, team: TeamId): Player | null {
  let best: Player | null = null;
  let bd = Infinity;
  for (const q of g.players) {
    if (q.team !== team || q.state === 'stun') continue;
    const d = dist(q.x, q.y, g.ball.x, g.ball.y);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

function onBall(g: Game, p: Player, it: Intent): Intent {
  if (p.state !== 'free') return it;
  const ai = p.ai;
  const hx = hoopX(p.team);
  const s = backDir(p.team);
  const d = g.distToHoop(p);
  const front = inFrontcourt(p.x, p.team);

  let near: Player | null = null;
  let nd = 99;
  for (const q of g.opponents(p.team)) {
    if (q.state === 'stun') continue;
    const dd = dist(p.x, p.y, q.x, q.y);
    if (dd < nd) { nd = dd; near = q; }
  }

  if (p.special >= 1) {
    const k = p.mon.special;
    if ((k === 'quake' && nd < 6) || k === 'freeze' || (front && d < 30 && k !== 'quake')) it.special = true;
  }

  const turboAvail = p.turbo > 0.25 || p.fx.surge > 0 || p.fire;
  if (ai.think <= 0) {
    ai.n++;
    ai.think = g.vary(p, 1, 0.18, 0.35);
    const dr = g.dunkRange(p, turboAvail);
    const range = p.r.sht >= 88 ? 27 : p.r.sht >= 78 ? 25.5 : p.r.sht >= 66 ? 20 : 12;
    const laneClear = !g.opponents(p.team).some((q) =>
      q.state !== 'stun' && segDist(q.x, q.y, p.x, p.y, hx, HOOP_Y) < 2.6 && dist(q.x, q.y, hx, HOOP_Y) < d);
    const cutter = g.teamPlayers(p.team).find((q) => q !== p && q.ai.cutT > 0 && g.distToHoop(q) < 12 && g.openness(q) > 4);
    const heldFor = g.time - p.lastCatch;
    const three = isThree(p.x, p.y, p.team);
    if (heldFor < 0.4) ai.pullUp = g.mix(p, 2) < (p.r.sht - 50) / 80;

    if (!front) ai.plan = 'drive';
    else if (g.shotClock < 3.2) ai.plan = 'shoot';
    else if (d < dr && (laneClear || g.mix(p, 10) < 0.08)) ai.plan = 'shoot';
    else if (d < 15 && !laneClear && g.mix(p, 11) < 0.3) ai.plan = g.mix(p, 12) < 0.5 ? 'pass' : 'jumper';
    else if (d < 7.5 && g.mix(p, 13) < 0.65) ai.plan = 'shoot';
    else if (cutter && g.mix(p, 14) < 0.5) { ai.plan = 'pass'; it.passTo = cutter; }
    else if (three && d < range && nd > 3 && heldFor < 1 && g.mix(p, 15) < 0.15 + (p.r.sht - 60) / 80) ai.plan = 'shoot';
    else if (ai.pullUp && d < Math.min(range, 26) && nd > 2) ai.plan = 'shoot';
    else if (d < range && nd > 3.5 && heldFor > 0.4 && g.mix(p, 16) < 0.22 + (p.r.sht - 55) / 100) ai.plan = 'shoot';
    else if (nd < 3.2 && g.mix(p, 17) < 0.35) ai.plan = 'pass';
    else if (heldFor > 1.2 && g.mix(p, 18) < 0.14) ai.plan = 'pass';
    else if (p.slot === 0 && heldFor < 1.5 && g.mix(p, 19) < 0.3) ai.plan = 'hold';
    else ai.plan = 'drive';
    if (g.mix(p, 20) < 0.3) ai.dodge = g.mix(p, 21) < 0.5 ? -1 : 1;
  }

  switch (ai.plan) {
    case 'shoot':
    case 'jumper':
      it.shoot = true;
      it.turbo = ai.plan === 'shoot' && turboAvail;
      ai.plan = 'none';
      return it;
    case 'pass': {
      it.pass = true;
      if (!it.passTo) it.passTo = bestPassTarget(g, p) ?? undefined;
      it.turbo = !!it.passTo && it.passTo.ai.cutT > 0 && g.distToHoop(it.passTo) < 14;
      ai.plan = 'none';
      return it;
    }
    case 'hold': {
      moveTo(p, it, hx + s * 25, HOOP_Y + (p.y < 25 ? -2 : 2));
      it.turbo = false;
      return it;
    }
    default: {
      const tx = front ? hx : hx + s * 26;
      let dx = tx - p.x;
      let dy = HOOP_Y - p.y;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      if (front && ai.pullUp && d < 25.5) {
        // Pull-up: hold at the arc and wait for the shot window.
        dx *= 0.15; dy *= 0.15;
      }
      if (near && nd < 6) {
        const dot = ((near.x - p.x) * dx + (near.y - p.y) * dy) / (nd || 1);
        if (dot > 0.4) {
          // Defender in the lane: slide sideways around them.
          const px = -dy * ai.dodge;
          const py = dx * ai.dodge;
          dx = dx * 0.45 + px * 0.9;
          dy = dy * 0.45 + py * 0.9;
        }
      }
      if (p.y < 4 && dy < 0) ai.dodge *= -1;
      if (p.y > 46 && dy > 0) ai.dodge *= -1;
      it.mx = dx;
      it.my = dy;
      it.turbo = turboAvail && (!front || d < 32) && p.turbo > 0.35;
      return it;
    }
  }
}

function bestPassTarget(g: Game, p: Player): Player | null {
  let best: Player | null = null;
  let bs = -Infinity;
  for (const q of g.teamPlayers(p.team)) {
    if (q === p || q.state === 'stun') continue;
    const open = Math.min(g.openness(q), 10);
    const s = open * 1.2 + (40 - g.distToHoop(q)) * 0.08 + q.r.sht * 0.03 + 3 * g.mix(q, 30);
    if (s > bs) { bs = s; best = q; }
  }
  return best;
}

function offBall(g: Game, p: Player, it: Intent) {
  const ai = p.ai;
  const hx = hoopX(p.team);
  const s = backDir(p.team);
  const [dx, sy] = SPOTS[p.slot];
  let tx = hx + s * dx;
  let ty = sy;
  if (p.slot >= 3 && p.r.sht >= 85) tx = hx + s * 21;

  const owner = g.ball.owner;
  if (ai.jitterT <= 0) {
    ai.n++;
    ai.jitterT = g.vary(p, 31, 1.5, 3.5);
    ai.jx = g.vary(p, 32, -3, 3);
    ai.jy = g.vary(p, 33, -3, 3);
    if (owner && owner.team === p.team && inFrontcourt(owner.x, p.team) && g.mix(p, 34) < 0.12 + p.r.ins / 500) {
      ai.cutT = g.vary(p, 35, 1.2, 2);
    }
  }
  if (ai.cutT > 0) {
    tx = hx + s * 3;
    ty = HOOP_Y + (p.y < HOOP_Y ? -3 : 3);
  } else {
    tx += ai.jx;
    ty += ai.jy;
  }
  // Give the ball handler room.
  if (owner && owner !== p && dist(owner.x, owner.y, tx, ty) < 7) {
    ty += ty < owner.y ? -5 : 5;
  }
  moveTo(p, it, tx, clamp(ty, 2, 48));
}

function defend(g: Game, p: Player, it: Intent, dt: number) {
  const opp = (1 - p.team) as TeamId;
  const man = g.manOf(p);
  const hx = hoopX(opp);
  const b = g.ball;
  const owner = b.owner && b.owner.team === opp ? b.owner : null;
  let tx: number;
  let ty: number;

  if (owner === man) {
    const l = dist(man.x, man.y, hx, HOOP_Y) || 1;
    tx = man.x + ((hx - man.x) / l) * 3;
    ty = man.y + ((HOOP_Y - man.y) / l) * 3;
    const d = dist(p.x, p.y, man.x, man.y);
    const aggro = g.aggro(p);
    if (g.phase === 'live' && d < 4.2) {
      // Reach for the ball when the defender's attention is up; whether it works is decided in the engine, by reach.
      // The urge to reach builds with attention and defensive skill; it goes for it at a threshold set by the matchup.
      const lunge = p.turbo > 0.6;
      p.ai.reach += dt * aggro * (0.3 * (p.r.def / 100) + (lunge ? 0.07 : 0));
      if (p.ai.reach >= g.vary(p, 36, 0.5, 1.2)) {
        p.ai.reach = 0;
        p.ai.n++;
        it.steal = true;
        it.turbo = lunge && g.mix(p, 37) < 0.2;
      }
    }
  } else {
    const l = dist(man.x, man.y, hx, HOOP_Y) || 1;
    const sag = clamp(dist(man.x, man.y, b.x, b.y) / 4, 2.5, 8);
    tx = man.x + ((hx - man.x) / l) * sag;
    ty = man.y + ((HOOP_Y - man.y) / l) * sag;
    tx += (b.x - tx) * 0.15;
    ty += (b.y - ty) * 0.15;
    // Rim protection: the big closest to the rim steps up on drives.
    if (owner && p.slot >= 3 && dist(owner.x, owner.y, hx, HOOP_Y) < 15) {
      const helper = g.teamPlayers(p.team)
        .filter((q) => q.slot >= 3)
        .sort((a, c) => dist(a.x, a.y, hx, HOOP_Y) - dist(c.x, c.y, hx, HOOP_Y))[0];
      if (helper === p) {
        const ol = dist(owner.x, owner.y, hx, HOOP_Y) || 1;
        tx = hx + ((owner.x - hx) / ol) * 4;
        ty = HOOP_Y + ((owner.y - HOOP_Y) / ol) * 4;
      }
    }
  }

  if (owner && (owner.state === 'shoot' || owner.state === 'layup' || owner.state === 'dunk') && p.ai.jumpIn < 0 && p.z === 0) {
    const range = owner.state === 'dunk' ? 10 : 6.5;
    if (dist(p.x, p.y, owner.x, owner.y) < range) p.ai.jumpIn = g.reactTime(p);
  }
  if (owner && p.special >= 1) {
    const k = p.mon.special;
    const d = dist(p.x, p.y, owner.x, owner.y);
    if ((k === 'quake' && d < 9) || k === 'freeze') it.special = true;
  }
  moveTo(p, it, tx, ty, 10);
}

function chaseBoard(g: Game, p: Player, it: Intent, dt: number) {
  const b = g.ball;
  if (b.mode === 'shot' && b.shot) {
    const hx = hoopX(b.shot.shooter.team);
    const dh = dist(p.x, p.y, hx, HOOP_Y);
    if (dh < 22 && (p.slot >= 2 || dh < 12)) {
      const l = dh || 1;
      moveTo(p, it, hx + ((p.x - hx) / l) * 4.5, HOOP_Y + ((p.y - HOOP_Y) / l) * 4.5, 99);
    } else if (p.team === g.offense) offBall(g, p, it);
    else defend(g, p, it, dt);
    return;
  }
  // Loose ball: the two nearest on each team go get it.
  const mates = g.teamPlayers(p.team)
    .filter((q) => q.state !== 'stun')
    .sort((a, c) => dist(a.x, a.y, b.x, b.y) - dist(c.x, c.y, b.x, b.y));
  const rank = mates.indexOf(p);
  const d = dist(p.x, p.y, b.x, b.y);
  if (rank < 2 || d < 10) {
    moveTo(p, it, b.x + b.vx * 0.25, b.y + b.vy * 0.25, 6);
    const top = p.heightFt + 1.6;
    if (d < 3 && b.vz < 2 && b.z > top && b.z < top + 3.5 && p.z === 0) it.shoot = true;
  } else if (p.team === g.offense) offBall(g, p, it);
  else defend(g, p, it, dt);
}
