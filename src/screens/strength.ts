// The strength line on a matchup card: the number the team really plays at, and where it comes from.
import { chemistry, teamOvr } from '../game/game';
import type { Mon } from '../data/pokemon';

export interface Strength {
  /** Starting-five mean OVR plus chemistry (the Team OVR shown elsewhere). */
  ovr: number;
  chem: number;
  boost: number;
  /** What the engine plays: `ovr` plus `boost`. */
  total: number;
}

export function strengthOf(starters: Mon[], boost = 0): Strength {
  const ovr = teamOvr(starters);
  return { ovr, chem: chemistry(starters), boost, total: Math.round(ovr + boost) };
}

/** The boost folded into a team's per-player ratings in an opponent preview: gyms and the Elite only, never your team. */
export const shownBoost = (t: { human?: boolean; boost?: number }) => (t.human ? 0 : t.boost ?? 0);

/** The rating a player shows in an opponent preview: card OVR plus that boost, as Game strength counts it. Display only. */
export const shownOvr = (m: Mon, boost = 0) => Math.min(99, Math.round(m.ovr + boost));

/** A CPU card passes `hideOvr`: Team OVR next to Game strength would show how far the team is boosted. */
export function strengthHtml(s: Strength, record = '', hideOvr = false): string {
  const plays = `<span class="nx-plays">Game strength <b>${s.total}</b></span>`;
  if (hideOvr) return `<p class="nx-str">${record ? `<span>${record}</span>` : ''}${plays}</p>`;
  const lineup = s.chem ? `OVR includes +${s.chem} lineup bonus` : 'No lineup bonus';
  return `<p class="nx-str"><span>${record ? `${record} · ` : ''}${s.ovr} OVR</span>${plays}<small>${lineup}</small></p>`;
}
