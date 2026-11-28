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

/** A CPU card passes `hideOvr`: Team OVR next to Game strength would show how far the team is boosted. */
export function strengthHtml(s: Strength, record = '', hideOvr = false): string {
  const plays = `<span class="nx-plays">Game strength <b>${s.total}</b></span>`;
  if (hideOvr) return `<p class="nx-str">${record ? `<span>${record}</span>` : ''}${plays}</p>`;
  const lineup = s.chem ? `OVR includes +${s.chem} lineup bonus` : 'No lineup bonus';
  return `<p class="nx-str"><span>${record ? `${record} · ` : ''}${s.ovr} OVR</span>${plays}<small>${lineup}</small></p>`;
}
