// This week's weekly card prize. Swap this object when the drawing changes. The screen renders it.
// It does not charge anyone and it does not collect a shipping address.
import { esc } from '../util';

export interface WeeklyCardPrize {
  /** Stable id for this drawing, so a later week is a new object rather than a rewritten screen. */
  id: string;
  name: string;
  /** Card category, for example "Supporter / Trainer". */
  kind: string;
  setName: string;
  cardNumber: string;
  /** Collector number printed on the card, for example "120/086". */
  printed: string;
  rarity: string;
  grade: string;
  cert: string;
  /** Whole cents, so $115.00 is 11500. */
  valueCents: number;
  buybackCents: number;
  vault: string;
  listedOn: string;
  /** Path under the site root, same style as raffle-rules.html. */
  image: string;
  imageWidth: number;
  imageHeight: number;
}

/** Week ending Monday, Nov 16, 2026 at 12:00 AM Pacific. */
export const THIS_WEEK_PRIZE: WeeklyCardPrize = {
  id: '2026-11-16-azs-tranquility',
  name: "AZ's Tranquility",
  kind: 'Supporter / Trainer',
  setName: '2026 Pokémon CRI EN',
  cardNumber: '#120',
  printed: '120/086',
  rarity: 'Special Illustration Rare',
  grade: 'PSA Gem Mint 10',
  cert: '1624777451',
  valueCents: 11500,
  buybackCents: 10350,
  vault: 'OmniVault',
  listedOn: 'Collector Crypt',
  image: 'raffle/azs-tranquility-psa10.webp',
  imageWidth: 480,
  imageHeight: 815,
};

/** Dollars from whole cents: 11500 -> "$115.00". */
export function usd(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${cents < 0 ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** The prize panel. A later week passes a different `WeeklyCardPrize`. */
export function prizeHtml(prize: WeeklyCardPrize = THIS_WEEK_PRIZE): string {
  const alt = `${prize.grade} slab of ${prize.name}, ${prize.setName} ${prize.cardNumber}, ${prize.rarity}, cert ${prize.cert}`;
  return `<section class="ch-prize" aria-label="This week's prize">
    <p class="eyebrow">This week's prize</p>
    <div class="ch-prize-body">
      <img src="${esc(prize.image)}" width="${prize.imageWidth}" height="${prize.imageHeight}" alt="${esc(alt)}">
      <div class="ch-prize-copy">
        <h3>${esc(prize.name)}</h3>
        <p>${esc(prize.kind)}</p>
        <p>${esc(prize.setName)} ${esc(prize.cardNumber)}</p>
        <p>${esc(prize.rarity)}, ${esc(prize.printed)}</p>
        <p>${esc(prize.grade)}</p>
        <p>Cert ${esc(prize.cert)}</p>
        <p class="ch-prize-money"><span>Value <b>${usd(prize.valueCents)}</b></span><span>Buyback <b>${usd(prize.buybackCents)}</b></span></p>
        <p class="ch-prize-vault">Vaulted at ${esc(prize.vault)} on ${esc(prize.listedOn)}.</p>
      </div>
    </div>
  </section>`;
}
