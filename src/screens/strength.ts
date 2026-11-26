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

const signed = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v * 10) / 10)}`;

export function strengthHtml(s: Strength, record = ''): string {
  const parts = [s.chem ? `OVR includes +${s.chem} lineup bonus` : 'No lineup bonus', s.boost ? `${signed(s.boost)} team boost` : 'no team boost'];
  return `<p class="nx-str"><span>${record ? `${record} · ` : ''}${s.ovr} OVR</span><span class="nx-plays">Game strength <b>${s.total}</b></span><small>${parts.join(' · ')}</small></p>`;
}
