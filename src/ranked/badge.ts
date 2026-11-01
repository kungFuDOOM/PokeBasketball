// Tier badge art (public/ranks/<stem>.png at 128px, <stem>@2x.png for dense screens). Pure, so it unit-tests in node.
import { esc } from '../util';
import { TIERS, ZENITH_IDX, rankName, tierIndex, tierName } from './rank';

/** CSS class that carries the tier colour (style.css .tier-0 .. .tier-7, .tier-z). */
export const tierClass = (divIdx: number) => (divIdx >= ZENITH_IDX ? 'tier-z' : `tier-${tierIndex(divIdx)}`);

/** File stems, in TIERS order; Zenith has its own. */
export const BADGE_FILES = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'prism', 'eclipse', 'master'] as const;
export const ZENITH_BADGE = 'zenith';

/** Badge file stem for a tier name as shown in the UI ('Pokémon Master' -> 'master', 'Zenith' -> 'zenith'); null when unknown. */
export function stemForTier(tier: string): string | null {
  if (tier === 'Zenith') return ZENITH_BADGE;
  const i = (TIERS as readonly string[]).indexOf(tier);
  return i < 0 ? null : BADGE_FILES[i];
}

export const badgeUrl = (stem: string, x2 = false) => `${import.meta.env.BASE_URL}ranks/${stem}${x2 ? '@2x' : ''}.png`;

function imgHtml(stem: string, alt: string, cls: string): string {
  return `<img class="rk-badge-img ${cls}" src="${badgeUrl(stem)}" srcset="${badgeUrl(stem)} 1x, ${badgeUrl(stem, true)} 2x" width="128" height="128" alt="${esc(alt)}" decoding="async" draggable="false">`;
}

/** The badge <img> for a division index (0..23, 24 = Zenith). Alt text is the tier name. */
export const badgeImgHtml = (divIdx: number, cls = ''): string =>
  imgHtml(divIdx >= ZENITH_IDX ? ZENITH_BADGE : BADGE_FILES[tierIndex(divIdx)], tierName(divIdx), cls);

/** The badge <img> for a tier name (the local mock's RankView); '' for an unranked player. */
export function badgeImgForTier(tier: string | null, cls = ''): string {
  const stem = tier ? stemForTier(tier) : null;
  return stem ? imgHtml(stem, tier!, cls) : '';
}

/** What a badge shows: a placed rank (division index 0..24), a player still in placements, or no rank at all. */
export type BadgeRank = { divIdx: number } | { placing: number; of?: number } | null;
export type BadgeSize = 'sm' | 'md' | 'lg';

/** The badge rank a RankedMe-shaped value stands for (placed, in placements, or none when unknown). */
export function badgeRankOf(me: { placing: boolean; placementsPlayed: number; divIdx: number | null } | null | undefined): BadgeRank {
  if (!me) return null;
  if (me.placing) return { placing: me.placementsPlayed };
  return me.divIdx === null ? null : { divIdx: me.divIdx };
}

/**
 * The one rank badge every player card uses (own profile, hub chip, name cards, results): tier art plus the division as text.
 * Placed players get their tier image and "Gold 2" / "Zenith"; placement players a grey placeholder with "Placement 2/5";
 * players with no rank (a guest, or not loaded) a grey placeholder with "Unranked". `label: false` draws the art only.
 */
export function renderRankBadge(rank: BadgeRank, o: { size?: BadgeSize; label?: boolean; cls?: string } = {}): string {
  const cls = `rk-rb rk-rb-${o.size ?? 'md'} ${o.cls ?? ''}`.trim();
  const text = (t: string) => (o.label === false ? '' : `<b class="rk-rb-text">${esc(t)}</b>`);
  if (rank && 'divIdx' in rank) {
    return `<span class="${cls} ${tierClass(rank.divIdx)}" data-rk-badge="ranked">${badgeImgHtml(rank.divIdx, 'rk-rb-img')}${text(rankName(rank.divIdx))}</span>`;
  }
  const label = rank ? `Placement ${rank.placing}/${rank.of ?? 5}` : 'Unranked';
  return `<span class="${cls} rk-rb-none" data-rk-badge="${rank ? 'placing' : 'unranked'}" role="img" aria-label="${esc(label)}"><i class="rk-rb-ph" aria-hidden="true">?</i>${text(label)}</span>`;
}
