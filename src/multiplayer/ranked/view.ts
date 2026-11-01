// Season 1 Ranked screens as HTML strings: the rank chip, placement progress, the sign-in panel and the post-match points
// block. Pure (no DOM, no network) so they unit-test in node. Menu and results screens only: nothing here is ever drawn
// over the court or the in-game HUD. Text and CSS only (index.ts wires the buttons; style.css has the look).
import { SIGNIN_GOOGLE } from '../../config/features';
import { esc } from '../../util';
import type { PhantomAction } from '../../wallet/phantom';
import { badgeImgHtml, badgeRankOf, renderRankBadge, type BadgeRank } from '../../ranked/badge';
import { DIV_POINTS, ZENITH_IDX, fromLadderScore, rankName, tierIndex, tierRanges } from '../../ranked/rank';
import type { ReportOutcome } from '../shared/matchService';
import type { RankedMe, RankedResult, ShieldItem, ShieldStatus, WeeklyChallenge } from './serverRank';
import { displayName } from './username';

const PLACEMENT_GAMES = 5;

/** CSS class that carries the tier colour (style.css: .tier-0 Bronze ... .tier-6 Pokémon Master, .tier-z Zenith). */
export const tierClass = (divIdx: number) => (divIdx >= ZENITH_IDX ? 'tier-z' : `tier-${tierIndex(divIdx)}`);
const seasonBadge = (n: number | null) => (n === null ? '' : `<span class="rk-season" title="Season ${n}">S${n}</span>`);
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : /(s|ch)$/.test(word) ? `${word}es` : `${word}s`}`;

/** "Gold 2 - 40 pts" / "Zenith 340". */
export const rankText = (divIdx: number, points: number) => (divIdx >= ZENITH_IDX ? `Zenith ${points}` : `${rankName(divIdx)} · ${points} pts`);

/** Five pips, `played` of them filled. */
function pips(played: number): string {
  return `<span class="rk-pips" aria-hidden="true">${Array.from({ length: PLACEMENT_GAMES }, (_, i) => `<i${i < played ? ' class="on"' : ''}></i>`).join('')}</span>`;
}

const HOUR = 3_600_000;
/** "5 h 12 m" / "12 m": a wait, rounded up to the minute. */
export function waitText(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m`;
}
/** "3 d" (whole days) or, inside the last day, "5 h". */
export function resetsText(ms: number): string {
  return ms >= 24 * HOUR ? `${Math.floor(ms / (24 * HOUR))} d` : `${Math.max(1, Math.ceil(ms / HOUR))} h`;
}

const blockText = (it: ShieldItem, now: number): string => {
  switch (it.block) {
    case 'used_today': return it.nextUseAt ? `Used today - back in ${waitText(Date.parse(it.nextUseAt) - now)}` : 'Used today';
    case 'placing': return "Placement games can't be shielded";
    case 'nothing_to_lose': return 'Nothing to lose';
    case 'zenith': return 'Not in Zenith';
    case 'empty': return 'None left. Earn one in the weekly challenge';
    default: return '';
  }
};

/** The Rank Shield item for the Ranked home: icon, count, an ARM toggle and the reason it is off (or "Armed for this match"). */
export function shieldItemHtml(it: ShieldItem | null | undefined, now = Date.now(), shop = false): string {
  if (!it) return '';
  const note = it.armed ? (it.locked ? 'Armed for this match' : 'Armed: saves the points of your next loss') : blockText(it, now);
  const can = !it.locked && (it.armed || it.block === null);
  return `<div class="rk-item${it.armed ? ' armed' : ''}${shop ? ' has-shop' : ''}" data-rk="shield">
    <span class="rk-item-ico" aria-hidden="true">🛡</span>
    <span class="rk-item-name"><strong>Rank Shield</strong><b class="rk-item-count" title="Rank Shields you hold">x${it.count}</b></span>
    <button class="btn rk-arm${it.armed ? ' on' : ''}" type="button" data-a="arm" aria-pressed="${it.armed}"${can ? '' : ' disabled'}>${it.armed ? 'ARMED' : 'ARM'}</button>
    ${note ? `<span class="rk-item-note" role="status">${esc(note)}</span>` : ''}
    ${shop ? '<button class="btn ghost rk-shop-btn" type="button" data-a="shop">Shop</button>' : ''}</div>`;
}

/** The weekly challenge card: "Play 10 ranked games - 6/10 - resets in 3 d" with the reward, or "Done this week". */
export function weeklyCardHtml(w: WeeklyChallenge | null | undefined, now = Date.now()): string {
  if (!w) return '';
  const title = w.kind === 'wins' ? `Win ${w.goal} ranked games` : w.kind === 'days' ? `Play ranked on ${w.goal} different days` : `Play ${w.goal} ranked games`;
  const resets = w.resetsAt ? ` - resets in ${resetsText(Date.parse(w.resetsAt) - now)}` : '';
  const pct = Math.round((100 * w.progress) / w.goal);
  return `<div class="rk-weekly${w.done ? ' done' : ''}" data-rk="weekly">
    <span class="rk-weekly-line"><strong>${esc(title)}</strong> - ${w.progress}/${w.goal}${esc(resets)}</span>
    <div class="rk-bar" role="img" aria-label="${w.progress} of ${w.goal}"><i style="width:${pct}%"></i></div>
    <span class="rk-reward">${w.done ? 'Done this week' : '1 free Rank Shield'}</span></div>`;
}

/** The small tag on the searching screen. */
export const shieldTagHtml = (st: ShieldItem | ShieldStatus | null | undefined) =>
  st?.armed ? '<p class="rk-queue-tag" data-rk="shield-tag">🛡 Shield armed</p>' : '';

function shieldNote(me: RankedMe | null): string {
  if (!me || !me.shieldActive || me.shieldCharge === null) return '';
  if (me.shieldCharge === 1) return '<span class="rk-shield on" title="Blocks your next demotion">🛡 Demotion Guard ready</span>';
  const n = me.shieldLossesLeft;
  return `<span class="rk-shield" title="Used. Recharges after 3 losses">🛡 Guard recharges${n !== null ? ` in ${plural(n, 'loss')}` : ''}</span>`;
}

/** The rank chip for the Ranked home: tier + division + Zenith/points bar + shield + season badge; during placements only the progress. */
export function rankChipHtml(me: RankedMe | null, o: { badge?: boolean } = {}): string {
  const art = (r: BadgeRank) => (o.badge === false ? '' : renderRankBadge(r, { size: 'lg', label: false, cls: 'rk-chip-badge' }));
  if (!me) return '<div class="rk-chip rk-none"><strong>Rank unavailable</strong><span>Could not load your rank from the server.</span></div>';
  const season = seasonBadge(me.season);
  const left = me.daysLeft !== null && me.season !== null ? `<span class="rk-sub">Season ${me.season} · ${plural(me.daysLeft, 'day')} left</span>` : '';
  if (me.placing) {
    return `<div class="rk-chip rk-placing" data-rk="placing">${art(badgeRankOf(me))}<div class="rk-top">${season}<strong>Placement ${me.placementsPlayed} / ${PLACEMENT_GAMES}</strong></div>
      ${pips(me.placementsPlayed)}<span class="rk-sub">Your rank is revealed after match ${PLACEMENT_GAMES}. Points stay hidden until then.</span>${left}</div>`;
  }
  const d = me.divIdx ?? 0;
  const pts = me.points ?? 0;
  const bar = d >= ZENITH_IDX ? '' : `<div class="rk-bar" role="img" aria-label="${pts} of ${DIV_POINTS} points"><i style="width:${Math.max(0, Math.min(100, pts))}%"></i></div>`;
  return `<div class="rk-chip ${tierClass(d)}" data-rk="ranked">${art({ divIdx: d })}<div class="rk-top">${season}<strong>${esc(d >= ZENITH_IDX ? 'Zenith' : rankName(d))}</strong>
    <span class="rk-pts">${d >= ZENITH_IDX ? `${pts} pts` : `${pts} / ${DIV_POINTS}`}</span></div>${bar}${shieldNote(me)}${left}</div>`;
}

/**
 * The sign-in panel shown to guests before Ranked. `error` is plain text. `google` (default: the SIGNIN_GOOGLE build flag)
 * offers Google next to Phantom; off, the panel is Phantom-only and Phantom becomes the primary button.
 */
export function signInPanelHtml(phantom: PhantomAction, o: { busy?: boolean; error?: string | null; why?: string; google?: boolean } = {}): string {
  const google = o.google ?? SIGNIN_GOOGLE;
  const dis = o.busy ? ' disabled' : '';
  const cls = google ? 'btn big' : 'btn primary big';
  const phantomBtn = phantom.kind === 'sign-in'
    ? `<button class="${cls}" data-a="phantom"${dis}>Sign in with Phantom</button>`
    : phantom.kind === 'open-in-phantom'
      ? `<a class="${cls}" data-a="phantom-open" href="${esc(phantom.href)}">Open in Phantom</a>`
      : `<a class="${cls}" data-a="phantom-install" href="${esc(phantom.href)}" target="_blank" rel="noopener">Get Phantom</a>`;
  const googleBtn = google ? `<button class="btn primary big" data-a="google"${dis}>Sign in with Google</button>` : '';
  const how = google
    ? 'Signing in with Google keeps your guest stats. A wallet is a fresh account. Signing only proves you own it. It costs nothing and never moves funds.'
    : 'A wallet is a fresh account. Signing only proves you own it. It costs nothing and never moves funds.';
  const phantomNote = phantom.kind === 'open-in-phantom' ? 'Phantom was not found here. This opens PokeJam inside the Phantom app, where you can sign in.'
    : phantom.kind === 'install' ? 'Phantom was not found in this browser. Install it, then come back and tap Sign in with Phantom.' : '';
  return `<div class="rk-signin" data-rk="signin">
    <p class="rk-why">${esc(o.why ?? 'Ranked needs a signed-in account so your rank is yours. Guests can still play Social and offline.')}</p>
    <div class="actions center rk-signin-btns">
      ${googleBtn}${phantomBtn}
    </div>
    ${phantomNote ? `<p class="note center">${esc(phantomNote)}</p>` : ''}
    <p class="note center">${how}</p>
    ${o.error ? `<p class="note center rk-error" role="alert">${esc(o.error)}</p>` : ''}
  </div>`;
}

const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** An accessible rank-up / rank-down / placed reveal: a badge flip (CSS, 2 s, off under reduced motion) with a Skip button. */
function reveal(kind: 'up' | 'down' | 'placed', divIdx: number, title: string): string {
  return `<div class="rk-anim rk-${kind} ${tierClass(divIdx)}" data-rk="anim"><div class="rk-flip"><div class="rk-face">
      ${badgeImgHtml(divIdx, 'rk-reveal-img')}<strong>${esc(divIdx >= ZENITH_IDX ? 'Zenith' : rankName(divIdx))}</strong></div></div>
    <p class="rk-title">${esc(title)}</p><button class="btn ghost rk-skip" data-rk-skip type="button">Skip</button></div>`;
}

/** The ladder score a result's `before` / `after` stand for, as a division and points. */
function atScore(score: number) {
  return score >= 2400 ? { divIdx: ZENITH_IDX, points: score - 2400 } : fromLadderScore(score);
}

/** What a finished Ranked match did to my rank, for the results screen. Works with any missing field (a placing player gets no numbers). */
export function postMatchHtml(out: ReportOutcome, won?: boolean): string {
  // My badge comes from the post-match rank; the opponent's only when the outcome carries it (the server does not send it yet).
  const mine = out.me ? badgeRankOf(out.me) : out.result?.divIdx != null ? { divIdx: out.result.divIdx } : undefined;
  return `${versusHtml(out.names, { me: mine, opp: out.oppRank })}${postBlock(out, won)}`;
}

/** "You (Ash_K) vs Misty_9": usernames only, escaped; a missing name reads as "Player". Nothing without names (local CPU games). */
export function versusHtml(names: ReportOutcome['names'], ranks: { me?: BadgeRank; opp?: BadgeRank } = {}): string {
  if (!names) return '';
  const card = (cls: string, name: string | null, r: BadgeRank | undefined) =>
    `<span class="rk-card ${cls}">${r === undefined ? '' : renderRankBadge(r, { size: 'sm', cls: 'rk-card-badge' })}<span class="rk-card-name">${esc(displayName(name))}</span></span>`;
  return `<p class="rk-vs">${card('rk-you', names.me, ranks.me)} <i>vs</i> ${card('rk-opp', names.opp, ranks.opp)}</p>`;
}

function postBlock(out: ReportOutcome, won?: boolean): string {
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
  return rankedBlock(r, me, verdict, season, won);
}

function rankedBlock(r: RankedResult, me: RankedMe | null, verdict: string, season: string, won?: boolean): string {
  const delta = r.delta;
  const after = r.divIdx !== null && r.points !== null ? { divIdx: r.divIdx, points: r.points } : r.after !== null ? atScore(r.after) : null;
  const before = r.before !== null ? atScore(r.before) : null;
  const up = r.event === 'promoted' || r.event === 'zenith';
  const down = r.event === 'demoted';
  const pts = delta === null ? '' : `<strong class="rk-delta ${delta >= 0 ? 'up' : 'down'}">${sign(delta)} pts</strong>`;
  const move = before && after ? `<span class="rk-sub">${esc(rankText(before.divIdx, before.points))} → ${esc(rankText(after.divIdx, after.points))}</span>` : after ? `<span class="rk-sub">${esc(rankText(after.divIdx, after.points))}</span>` : '';
  const bar = after && after.divIdx < ZENITH_IDX ? `<div class="rk-bar" role="img" aria-label="${after.points} of ${DIV_POINTS} points"><i style="width:${Math.max(0, Math.min(100, after.points))}%"></i></div>` : '';
  let shield = '';
  if (r.event === 'shielded') shield = '<span class="rk-shield used">🛡 Demotion Guard used: your demotion was blocked.</span>';
  const charge = shieldNote(me);
  const item = r.shield?.used ? `<span class="rk-shield used">🛡 Rank Shield saved you ${plural(r.shield.saved, 'point')}</span>`
    : r.shield?.armed && (won ?? (delta !== null && delta > 0)) ? '<span class="rk-shield on">🛡 Shield kept - you won</span>' : '';
  if (charge && (r.event === 'shielded' || me?.shieldCharge === 0)) shield += charge;
  const anim = after && up ? reveal('up', after.divIdx, r.event === 'zenith' ? 'Welcome to Zenith!' : `Rank up! ${rankName(after.divIdx)}`)
    : after && down ? reveal('down', after.divIdx, `Demoted to ${rankName(after.divIdx)}`) : '';
  return `<div class="rk-post ${after ? tierClass(after.divIdx) : ''}" data-rk="post">${verdict}${after && !anim ? badgeImgHtml(after.divIdx, 'rk-post-img') : ''}${pts}${anim}${move}${bar}${item}${shield}${season}</div>`;
}

/** The win/loss ranges for a division's tier, for the explainer ("Gold: win 20..38, loss 11..19"). */
export function tierRangeText(divIdx: number): string {
  const t = tierRanges(divIdx);
  return `win ${t.winMin}..${t.winMax}, loss ${t.lossMin}..${t.lossMax}`;
}

/** The username picker. `error` is plain text (escaped here). The form is wired by mountUsernamePicker (profile screen / Ranked home). */
export function usernamePickerHtml(o: { value?: string; error?: string | null; busy?: boolean; note?: string } = {}): string {
  return `<form class="un-pick" data-un="picker" novalidate>
    <label class="field" for="un-input">Choose your username
      <input id="un-input" name="username" maxlength="16" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(o.value ?? '')}" aria-describedby="un-note"${o.error ? ' aria-invalid="true"' : ''}>
    </label>
    <p class="note center" id="un-note">${esc(o.note ?? '3 to 16 letters, numbers or underscores. Other players see it. You can change it once every 30 days.')}</p>
    ${o.error ? `<p class="note center rk-error" role="alert">${esc(o.error)}</p>` : ''}
    <button class="btn primary big" type="submit"${o.busy ? ' disabled' : ''}>Save username</button>
  </form>`;
}
