// Pack Battles visuals, from the prototype (pp/pack-battles-prototype src/ui/pack.ts): the pulled card as a graded
// slab, the machine's odds, the reveal, and the keep-or-sell buttons. Pack art is kungFuDOOM's (public/art/pack-battle).
import { esc } from '../../util';
import { TIERS, usd, type PackTier, type Pull } from './service';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const pct = (v: number) => `${+(v * 100).toFixed(v < 0.01 ? 1 : 0)}%`;

export const RARITY_COLORS: Record<string, string> = { Epic: '#ffcb05', Rare: '#e3350d', Uncommon: '#3b6fd8', Common: '#9aa0c8' };
const rarityColor = (r: string | null) => RARITY_COLORS[cap(r ?? '')] ?? '#9aa0c8';
/** Text on a rarity color: dark on Epic's yellow, white on the rest. */
const rarityInk = (r: string | null) => (cap(r ?? '') === 'Epic' ? '#1a1400' : '#fff');

/** The tier's pack, as kungFuDOOM's art. */
export function packArt(tier: PackTier, width = 120, cls = ''): string {
  const t = TIERS[tier];
  return `<img class="pack-art ${cls}" src="${import.meta.env.BASE_URL}${t.art}" width="${width}" height="${Math.round(width * 1.4)}" alt="${esc(t.label)}" style="--tc:${t.color}">`;
}

/** A pulled card, shown like a graded slab: label with grade and insured value over the card image. */
export function cardHtml(p: Pull, size: 'small' | 'big' = 'big', empty = 'Card image unavailable'): string {
  return `
    <figure class="slab ${size}" style="--rc:${rarityColor(p.rarity)}; --ri:${rarityInk(p.rarity)}">
      <figcaption class="slab-label">
        <span class="slab-name">${esc(p.name)}</span>
        <span class="slab-meta">${p.grade ? `<b>${esc(p.grade)}</b>` : ''}${p.rarity ? `<i>${esc(cap(p.rarity))}</i>` : ''}${p.insuredValue !== null && p.insuredValue !== undefined ? `<em>$${Math.round(p.insuredValue)}</em>` : ''}</span>
      </figcaption>
      <div class="slab-window">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" referrerpolicy="no-referrer">` : `<span class="slab-none">${esc(empty)}</span>`}</div>
    </figure>`;
}

/** A machine's odds as one stacked bar, colored by rarity, with the numbers underneath. */
export function oddsBarHtml(odds: Record<string, number>, label: string): string {
  const rows = Object.entries(odds).filter(([, v]) => v > 0).map(([k, v]) => [cap(k), v] as const);
  if (!rows.length) return '';
  return `
    <div class="odds-bar" role="img" aria-label="${esc(label)} odds: ${rows.map(([k, v]) => `${pct(v)} ${k}`).join(', ')}">
      <div class="ob-track">${rows.map(([k, v]) => `<i style="--rc:${rarityColor(k)}; flex-grow:${v}"></i>`).join('')}</div>
      <ul class="ob-key">${rows.map(([k, v]) => `<li style="--rc:${rarityColor(k)}"><b>${pct(v)}</b> ${k}</li>`).join('')}</ul>
    </div>`;
}

/** The card coming out of the pack: a flash, the slab flipping in, a burst in the rarity's color and the card's value. */
export function revealHtml(p: Pull): string {
  const big = ['Rare', 'Epic'].includes(cap(p.rarity ?? ''));
  return `
    <div class="pull-reveal ${big ? 'hit' : ''}" style="--rc:${rarityColor(p.rarity)}; --ri:${rarityInk(p.rarity)}">
      <i class="burst" aria-hidden="true"></i>
      <span class="pr-flash" aria-hidden="true"></span>
      ${cardHtml(p, 'big')}
      ${p.rarity ? `<span class="pr-rarity">${esc(cap(p.rarity))} pull${big ? '!' : ''}</span>` : ''}
      ${p.insuredValue !== null && p.insuredValue !== undefined ? `<p class="pr-value">Insured value <b>$${Math.round(p.insuredValue)}</b></p>` : ''}
    </div>`;
}

type Choice = 'keep' | 'sell';

/** The two buttons at the reveal: keep the card, or sell it straight back. A clock shows what happens with no pick. */
export function choiceHtml(p: { id: string; chooseBy: number | null; ifNoChoice: Choice; sellEstimate: number | null }, compact = false): string {
  return `
    <div class="prize-choice ${compact ? 'compact' : ''}" data-k="choice" data-prize="${esc(p.id)}" data-by="${p.chooseBy ?? ''}" data-fallback="${p.ifNoChoice}">
      <button class="btn primary" data-choose="keep">Keep it<small>The graded card, to your wallet</small></button>
      <button class="btn" data-choose="sell">Sell it back<small>${p.sellEstimate ? `About ${usd(p.sellEstimate)}, to your balance` : 'Instant buyback, to your balance'}</small></button>
      <p class="pc-clock" data-k="clock" aria-live="polite"></p>
    </div>`;
}

/** Wire up choiceHtml: ticks the clock, sends the pick, and reports it (or the error) through `done`. */
export function bindChoice(el: HTMLElement, choose: (id: string, c: Choice) => Promise<unknown>, done: (c: Choice | null, err?: unknown) => void) {
  const box = el.matches('[data-k="choice"]') ? el : el.querySelector<HTMLElement>('[data-k="choice"]');
  if (!box) return;
  const by = Number(box.dataset.by) || 0;
  const fallback: Choice = box.dataset.fallback === 'sell' ? 'sell' : 'keep';
  const clock = box.querySelector<HTMLElement>('[data-k="clock"]')!;
  const buttons = [...box.querySelectorAll<HTMLButtonElement>('[data-choose]')];
  let picked = false;
  const tick = () => {
    if (!box.isConnected) return window.clearInterval(timer);
    if (picked) return;
    const left = Math.max(0, Math.ceil((by - Date.now()) / 1000));
    const what = fallback === 'sell' ? 'sell it back' : 'keep it';
    if (!by) clock.textContent = '';
    else if (left > 0) clock.textContent = `No pick in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} and we'll ${what}, as your prize setting says.`;
    else {
      clock.textContent = `Time's up: we'll ${what}, as your prize setting says.`;
      buttons.forEach((b) => (b.disabled = true));
      window.clearInterval(timer);
      done(null);
    }
  };
  const timer = window.setInterval(tick, 1000);
  tick();
  buttons.forEach((b) => b.addEventListener('click', () => {
    const c: Choice = b.dataset.choose === 'sell' ? 'sell' : 'keep';
    picked = true;
    buttons.forEach((x) => { x.disabled = true; x.classList.toggle('on', x === b); });
    clock.textContent = c === 'sell' ? 'Selling it back…' : 'Sending it to your wallet…';
    choose(box.dataset.prize!, c).then(() => { window.clearInterval(timer); done(c); }).catch((e) => {
      picked = false;
      buttons.forEach((x) => { x.disabled = false; x.classList.remove('on'); });
      done(null, e);
      tick();
    });
  }));
}

/** Where the winner's prize is: opening, revealed, delivered. */
export function prizeStepsHtml(reached: number, last = 'Delivered'): string {
  const steps = ['Opening your pack', 'Card revealed', last];
  return `<ol class="prize-steps">${steps.map((s, i) => `<li class="${i < reached ? 'done' : i === reached ? 'on' : ''}">${esc(s)}</li>`).join('')}</ol>`;
}
