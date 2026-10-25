// The PokeJam Master cutscene: after a title won with every badge, the nine badges light up one by one, the title
// slams in over the trophy and the team's Pokémon, and confetti falls. Badges, sprites and trophy are the game's own
// art; only the glow, confetti and text are code.
import { spriteUrl } from '../data/pokemon';
import { badgesEarned, monOf, type Franchise } from '../franchise/league';
import { celebrationCast, seasonLabel } from '../franchise/moments';
import { SLAM_AT, lightAt } from '../music/master';
import type { MasterSound } from '../music/master';
import { badgeSvg } from '../ui/badges';
import { TROPHY_IMG } from '../ui/trophy';
import { esc } from '../util';
import { reducedMotion } from './celebration';
import { confetti, mount } from './moments';

/** The badge case in order: eight gym badges, then the Elite Four emblem. */
function badgeList(f: Franchise): { id: number; name: string; label: string }[] {
  const gyms = f.teams.filter((t) => t.gym).sort((a, b) => a.gym! - b.gym!);
  const elite = f.teams.find((t) => t.elite);
  const got = badgesEarned(f);
  return [...gyms.map((t) => ({ id: t.id, name: t.badge!, label: `${t.badge} Badge` })), ...(elite ? [{ id: elite.id, name: 'Elite', label: 'Elite Four emblem' }] : [])]
    .filter((b) => got.has(b.id));
}

/** `sound` is the scene's audio; omitted, it is silent. Tap, Esc, Enter or the Skip button closes it, which also stops all sound and speech. */
export function masterScreen(f: Franchise, done: () => void, sound?: MasterSound) {
  const me = f.teams[0];
  const badges = badgeList(f);
  const cast = celebrationCast(f, me, 6);
  const uids = [cast.mvp, ...cast.crew].filter((u): u is string => !!u);
  const sprite = (u: string, i: number) => `<img class="mm-mon" style="--i:${i}" src="${spriteUrl(monOf(f, u).dex)}" alt="">`;
  const half = Math.ceil(uids.length / 2);
  const html = `
    <canvas class="confetti" aria-hidden="true"></canvas>
    <button class="mm-skip" type="button" data-skip>Skip</button>
    <div class="mo-body mm-body" style="--tc:${me.color};--tc2:${me.color2}">
      <p class="eyebrow mm-eyebrow">${esc(me.name)} · ${esc(seasonLabel(f.season))}</p>
      <h1 class="mm-title"><span>PokeJam</span> <span>Master</span></h1>
      <div class="mm-stage">
        <div class="mm-side left">${uids.slice(0, half).map(sprite).join('')}</div>
        <div class="mm-trophy"><img class="trophy-img" src="${esc(TROPHY_IMG)}" alt="Championship trophy"></div>
        <div class="mm-side right">${uids.slice(half).map((u, i) => sprite(u, i + half)).join('')}</div>
      </div>
      <ul class="mm-badges" aria-label="Badges earned">${badges.map((b, i) => `<li class="mm-badge" data-i="${i}" title="${esc(b.label)}">${badgeSvg(b.name, true, 44)}</li>`).join('')}</ul>
      <p class="mm-line">Every badge. The title. You are a PokeJam Master!</p>
      <p class="mo-hint mm-hint">Tap to continue</p>
    </div>`;
  const timers: number[] = [];
  const el = mount(html, 'master', done, () => { timers.forEach((t) => window.clearTimeout(t)); stopConfetti(); sound?.stop(); });
  const slots = [...el.querySelectorAll<HTMLElement>('.mm-badge')];
  slots.forEach((s, i) => timers.push(window.setTimeout(() => s.classList.add('lit'), lightAt(i) * 1000)));
  // The title and the confetti come in with the big chord.
  let stopConfetti = () => {};
  timers.push(window.setTimeout(() => {
    el.classList.add('slam');
    stopConfetti = confetti(el, ['#ffcb05', '#f2f0e6', me.color, '#e3350d', '#3b6fd8', '#43b05c']);
  }, SLAM_AT * 1000));
  sound?.start();
  if (reducedMotion()) el.classList.add('calm');
}
