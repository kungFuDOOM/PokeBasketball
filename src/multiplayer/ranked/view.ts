// Season 1 Ranked screens as HTML strings: the rank chip, placement progress, the sign-in panel and the post-match points
// block. Pure (no DOM, no network) so they unit-test in node. Menu and results screens only: nothing here is ever drawn
// over the court or the in-game HUD. Text and CSS only (index.ts wires the buttons; style.css has the look).
import { esc } from '../../util';
import type { PhantomAction } from '../../wallet/phantom';
import { DIV_POINTS, ZENITH_IDX, fromLadderScore, rankName, tierIndex, tierRanges } from '../../ranked/rank';
import type { ReportOutcome } from '../shared/matchService';
import type { RankedMe, RankedResult } from './serverRank';

const PLACEMENT_GAMES = 5;

/** CSS class that carries the tier colour (style.css: .tier-0 Bronze ... .tier-7 Pokémon Master, .tier-z Zenith). */
export const tierClass = (divIdx: number) => (divIdx >= ZENITH_IDX ? 'tier-z' : `tier-${tierIndex(divIdx)}`);
const seasonBadge = (n: number | null) => (n === null ? '' : `<span class="rk-season" title="Season ${n}">S${n}</span>`);
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : /(s|ch)$/.test(word) ? `${word}es` : `${word}s`}`;

/** "Gold 2 - 40 pts" / "Zenith 340". */
export const rankText = (divIdx: number, points: number) => (divIdx >= ZENITH_IDX ? `Zenith ${points}` : `${rankName(divIdx)} · ${points} pts`);

/** Five pips, `played` of them filled. */
function pips(played: number): string {
  return `<span class="rk-pips" aria-hidden="true">${Array.from({ length: PLACEMENT_GAMES }, (_, i) => `<i${i < played ? ' class="on"' : ''}></i>`).join('')}</span>`;
}

function shieldNote(me: RankedMe | null): string {
  if (!me || !me.shieldActive || me.shieldCharge === null) return '';
  if (me.shieldCharge === 1) return '<span class="rk-shield on" title="Blocks your next demotion">🛡 Shield ready</span>';
  const n = me.shieldLossesLeft;
  return `<span class="rk-shield" title="Used. Recharges after 3 losses">🛡 Recharges${n !== null ? ` in ${plural(n, 'loss')}` : ''}</span>`;
}

/** The rank chip for the Ranked home: tier + division + Zenith/points bar + shield + season badge; during placements only the progress. */
export function rankChipHtml(me: RankedMe | null): string {
  if (!me) return '<div class="rk-chip rk-none"><strong>Rank unavailable</strong><span>Could not load your rank from the server.</span></div>';
  const season = seasonBadge(me.season);
  const left = me.daysLeft !== null && me.season !== null ? `<span class="rk-sub">Season ${me.season} · ${plural(me.daysLeft, 'day')} left</span>` : '';
  if (me.placing) {
    return `<div class="rk-chip rk-placing" data-rk="placing"><div class="rk-top">${season}<strong>Placement ${me.placementsPlayed} / ${PLACEMENT_GAMES}</strong></div>
      ${pips(me.placementsPlayed)}<span class="rk-sub">Your rank is revealed after match ${PLACEMENT_GAMES}. Points stay hidden until then.</span>${left}</div>`;
  }
  const d = me.divIdx ?? 0;
  const pts = me.points ?? 0;
  const bar = d >= ZENITH_IDX ? '' : `<div class="rk-bar" role="img" aria-label="${pts} of ${DIV_POINTS} points"><i style="width:${Math.max(0, Math.min(100, pts))}%"></i></div>`;
  return `<div class="rk-chip ${tierClass(d)}" data-rk="ranked"><div class="rk-top">${season}<strong>${esc(d >= ZENITH_IDX ? 'Zenith' : rankName(d))}</strong>
    <span class="rk-pts">${d >= ZENITH_IDX ? `${pts} pts` : `${pts} / ${DIV_POINTS}`}</span></div>${bar}${shieldNote(me)}${left}</div>`;
}

/** The sign-in panel shown to guests before Ranked. `error` is plain text. */
export function signInPanelHtml(phantom: PhantomAction, o: { busy?: boolean; error?: string | null } = {}): string {
  const dis = o.busy ? ' disabled' : '';
  const phantomBtn = phantom.kind === 'sign-in'
    ? `<button class="btn big" data-a="phantom"${dis}>Sign in with Phantom</button>`
    : phantom.kind === 'open-in-phantom'
      ? `<a class="btn big" data-a="phantom-open" href="${esc(phantom.href)}">Open in Phantom</a>`
      : `<a class="btn big" data-a="phantom-install" href="${esc(phantom.href)}" target="_blank" rel="noopener">Get Phantom</a>`;
  const phantomNote = phantom.kind === 'open-in-phantom' ? 'Phantom was not found here. This opens PokeJam inside the Phantom app, where you can sign in.'
    : phantom.kind === 'install' ? 'Phantom was not found in this browser. Install it, then come back and tap Sign in with Phantom.' : '';
  return `<div class="rk-signin" data-rk="signin">
    <p class="rk-why">Ranked needs a signed-in account so your rank is yours. Guests can still play Social and offline.</p>
    <div class="actions center rk-signin-btns">
      <button class="btn primary big" data-a="google"${dis}>Sign in with Google</button>
      ${phantomBtn}
    </div>
    ${phantomNote ? `<p class="note center">${esc(phantomNote)}</p>` : ''}
    <p class="note center">Signing in with Google keeps your guest stats. A wallet is a fresh account. Signing only proves you own it. It costs nothing and never moves funds.</p>
    ${o.error ? `<p class="note center rk-error" role="alert">${esc(o.error)}</p>` : ''}
  </div>`;
}

const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** An accessible rank-up / rank-down / placed reveal: a badge flip (CSS, 2 s, off under reduced motion) with a Skip button. */
function reveal(kind: 'up' | 'down' | 'placed', divIdx: number, title: string): string {
  return `<div class="rk-anim rk-${kind} ${tierClass(divIdx)}" data-rk="anim"><div class="rk-flip"><div class="rk-face">
      <strong>${esc(divIdx >= ZENITH_IDX ? 'Zenith' : rankName(divIdx))}</strong></div></div>
    <p class="rk-title">${esc(title)}</p><button class="btn ghost rk-skip" data-rk-skip type="button">Skip</button></div>`;
}

/** The ladder score a result's `before` / `after` stand for, as a division and points. */
function atScore(score: number) {
  return score >= 2400 ? { divIdx: ZENITH_IDX, points: score - 2400 } : fromLadderScore(score);
}

/** What a finished Ranked match did to my rank, for the results screen. Works with any missing field (a placing player gets no numbers). */
export function postMatchHtml(out: ReportOutcome, won?: boolean): string {
  if (out.status === 'pending') return '<p class="note center">Waiting for your opponent to confirm the result. Your rank updates when they do.</p>';
  if (out.status === 'void') return '<p class="note center">The two results did not match, so this match was not rated.</p>';
  const r = out.result;
  if (!r) return '';
  const me = out.me ?? null;
  const season = me?.season != null ? `<span class="rk-sub">Season ${me.season}</span>` : '';
  const verdict = won === undefined ? '' : `<span class="rk-wl ${won ? 'w' : 'l'}">${won ? 'WIN' : 'LOSS'}</span>`;

  if (r.placing && r.event !== 'placed') {
    const played = Math.min(PLACEMENT_GAMES, r.placementsPlayed ?? me?.placementsPlayed ?? 0);
    const more = PLACEMENT_GAMES - played;
    return `<div class="rk-post rk-placing" data-rk="post-placing">${verdict}
      <strong class="rk-big">Placement ${played} / ${PLACEMENT_GAMES}</strong>${pips(played)}
      <span class="rk-sub">${more > 0 ? `${plural(more, 'more match')} to your rank.` : 'Placements complete.'} Points stay hidden until then.</span>${season}</div>`;
  }
  if (r.event === 'placed' && r.divIdx !== null && r.points !== null) {
    return `<div class="rk-post" data-rk="post-placed">${verdict}${reveal('placed', r.divIdx, `Placed: ${rankText(r.divIdx, r.points)}`)}
      <div class="rk-bar" role="img" aria-label="${r.points} of ${DIV_POINTS} points"><i style="width:${r.divIdx >= ZENITH_IDX ? 100 : r.points}%"></i></div>${season}</div>`;
  }
  return rankedBlock(r, me, verdict, season);
}

function rankedBlock(r: RankedResult, me: RankedMe | null, verdict: string, season: string): string {
  const delta = r.delta;
  const after = r.divIdx !== null && r.points !== null ? { divIdx: r.divIdx, points: r.points } : r.after !== null ? atScore(r.after) : null;
  const before = r.before !== null ? atScore(r.before) : null;
  const up = r.event === 'promoted' || r.event === 'zenith';
  const down = r.event === 'demoted';
  const pts = delta === null ? '' : `<strong class="rk-delta ${delta >= 0 ? 'up' : 'down'}">${sign(delta)} pts</strong>`;
  const move = before && after ? `<span class="rk-sub">${esc(rankText(before.divIdx, before.points))} → ${esc(rankText(after.divIdx, after.points))}</span>` : after ? `<span class="rk-sub">${esc(rankText(after.divIdx, after.points))}</span>` : '';
  const bar = after && after.divIdx < ZENITH_IDX ? `<div class="rk-bar" role="img" aria-label="${after.points} of ${DIV_POINTS} points"><i style="width:${Math.max(0, Math.min(100, after.points))}%"></i></div>` : '';
  let shield = '';
  if (r.event === 'shielded') shield = '<span class="rk-shield used">🛡 Shield used: your demotion was blocked.</span>';
  const charge = shieldNote(me);
  if (charge && (r.event === 'shielded' || me?.shieldCharge === 0)) shield += charge;
  const anim = after && up ? reveal('up', after.divIdx, r.event === 'zenith' ? 'Welcome to Zenith!' : `Rank up! ${rankName(after.divIdx)}`)
    : after && down ? reveal('down', after.divIdx, `Demoted to ${rankName(after.divIdx)}`) : '';
  return `<div class="rk-post ${after ? tierClass(after.divIdx) : ''}" data-rk="post">${verdict}${pts}${anim}${move}${bar}${shield}${season}</div>`;
}

/** The win/loss ranges for a division's tier, for the explainer ("Gold: win 20..38, loss 11..19"). */
export function tierRangeText(divIdx: number): string {
  const t = tierRanges(divIdx);
  return `win ${t.winMin}..${t.winMax}, loss ${t.lossMin}..${t.lossMax}`;
}
