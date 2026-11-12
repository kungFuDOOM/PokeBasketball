// The weekly challenges screen. Pure HTML. Progress comes from pokejam_raffle_me; this file does not count games.
import { esc } from '../util';
import { RAFFLE_DEFAULTS, configFromJson, scoreRaffle, type RaffleConfig } from './entries';
import type { RaffleMe } from './client';
import { prizeHtml } from './prize';

export interface ChallengeRow { label: string; have: number; need: number; done: boolean; detail?: string }

export interface ChallengeModel {
  signedIn: boolean;
  /** When this week ends, or null when the server hasn't said. */
  resetsAt: string | null;
  rows: ChallengeRow[];
  base: boolean;
  grind: number;
  onlineExtra: number;
  wins: number;
  gamesPer: number;
  winsPer: number;
  pjamPer: number;
  bonusCap: number;
  wallet: string | null;
  /** Challenge entries already on the server. Holder entries are added when `holderNow` is a number. */
  entriesNow: number;
  /** Holder entries from the server balance read. Null while that read has not come back. */
  holderNow: number | null;
  /** The balance read failed. Holder entries are still counted when the winner is drawn. */
  holderError: boolean;
  /** Whole tokens counted toward holder entries. */
  countedCap: number;
  /** Signed in, and no wallet on the account yet. */
  showLink: boolean;
  lastDraw: { won: boolean; entries: number; total: number } | null;
}

const zeros = { offline: 0, online: 0, onlineWins: 0, socialMatches: 0, shares: 0, rankSteps: 0, zenith: false };

function rowsFrom(cfg: RaffleConfig, have: { offline: number; online: number; social: number; rank: number; zenith: boolean }): ChallengeRow[] {
  const score = scoreRaffle({ ...zeros, offline: have.offline, online: have.online, socialMatches: have.social, rankSteps: have.rank, zenith: have.zenith }, cfg, 0n);
  return [
    { label: 'Play offline', have: have.offline, need: cfg.offlineGames, done: have.offline >= cfg.offlineGames, detail: 'Quick Play or Franchise, played by you' },
    { label: 'Play online', have: have.online, need: cfg.onlineGames, done: have.online >= cfg.onlineGames, detail: 'Finished matches' },
    { label: 'Social', have: have.social, need: cfg.social, done: score.socialHave >= cfg.social, detail: 'Share a result or finish a social match' },
    { label: 'Climb a rank', have: have.rank, need: cfg.rankSteps, done: score.rankDone, detail: have.zenith ? 'Zenith, the top rank' : 'One step up the ladder' },
  ];
}

export function modelFromServer(me: RaffleMe): ChallengeModel {
  const cfg = configFromJson(me.config);
  const s = me.score;
  const c = me.counts;
  return {
    signedIn: me.signed_in,
    resetsAt: me.resets_at,
    rows: [
      { label: 'Play offline', have: s.offline.have, need: s.offline.need, done: s.offline.done, detail: 'Quick Play or Franchise, played by you' },
      { label: 'Play online', have: s.online.have, need: s.online.need, done: s.online.done, detail: 'Finished matches' },
      { label: 'Social', have: s.social.have, need: s.social.need, done: s.social.done, detail: 'Share a result or finish a social match' },
      { label: 'Climb a rank', have: s.rank.have, need: s.rank.need, done: s.rank.done, detail: s.rank.zenith ? 'Zenith, the top rank' : 'One step up the ladder' },
    ],
    base: s.base,
    grind: s.grind,
    onlineExtra: Math.max(0, c.online - cfg.onlineGames),
    wins: c.online_wins,
    gamesPer: cfg.grindOnlinePerEntry,
    winsPer: cfg.grindWinsPerEntry,
    pjamPer: cfg.pjamPerEntry,
    bonusCap: cfg.bonusCap,
    wallet: me.wallet,
    entriesNow: s.total,
    holderNow: me.wallet ? null : 0,
    holderError: false,
    countedCap: cfg.pjamCountedCap,
    showLink: me.signed_in && !me.wallet,
    lastDraw: me.last_draw,
  };
}

export function modelFromDefaults(): ChallengeModel {
  const cfg = RAFFLE_DEFAULTS;
  return {
    signedIn: false, resetsAt: null,
    rows: rowsFrom(cfg, { offline: 0, online: 0, social: 0, rank: 0, zenith: false }),
    base: false, grind: 0, onlineExtra: 0, wins: 0,
    gamesPer: cfg.grindOnlinePerEntry, winsPer: cfg.grindWinsPerEntry, pjamPer: cfg.pjamPerEntry, bonusCap: cfg.bonusCap,
    wallet: null, entriesNow: 0, holderNow: 0, holderError: false, countedCap: cfg.pjamCountedCap, showLink: false, lastDraw: null,
  };
}

export const resetLabel = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Monday 00:00 PT';
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
};

const shortWallet = (w: string) => (w.length <= 12 ? w : `${w.slice(0, 4)}…${w.slice(-4)}`);

const amount = (n: number) => n.toLocaleString('en-US');

/** Compact whole-token count for the menu ticker: 1,000,000 -> "1M". Anything else stays grouped digits. */
export function compactTokenAmount(n: number): string {
  if (Number.isInteger(n) && n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  return amount(n);
}

/**
 * One menu-ticker line. The PJAM amount is the raffle config (the defaults, on the menu: the menu does not
 * fetch). The challenges screen still shows the live row if an operator changes it.
 */
/** The line on the challenges screen. Amounts come from the raffle config. */
export function holderOfferText(cfg: RaffleConfig = RAFFLE_DEFAULTS): string {
  const step = compactTokenAmount(cfg.pjamPerEntry);
  const cap = compactTokenAmount(cfg.pjamCountedCap);
  return `Hold ${step} $PJAM and link your wallet to enter automatically, 1 entry per ${step}, up to ${cap} counted`;
}

export function weeklyChallengesTickerText(cfg: RaffleConfig = RAFFLE_DEFAULTS): string {
  const step = compactTokenAmount(cfg.pjamPerEntry);
  return `Weekly Challenges are live — hold ${step} $PJAM and link your wallet to enter automatically, or finish all weekly challenges, for a chance to win a Pokémon card!`;
}

/** The ticker line as HTML. The words are the text above; the PJAM amount stays the config value. */
export function weeklyChallengesTickerHtml(cfg: RaffleConfig = RAFFLE_DEFAULTS): string {
  return weeklyChallengesTickerText(cfg);
}

/** The screen body. Every string from the server is escaped. */
export function challengesHtml(m: ChallengeModel, error?: string | null): string {
  const rows = m.rows.map((r) => `<li class="${r.done ? 'done' : ''}"><span><b>${esc(r.label)}</b><small>${esc(r.detail ?? '')}</small></span><strong>${r.done ? 'Done' : `${r.have}/${r.need}`}</strong></li>`).join('');
  const when = m.resetsAt ? resetLabel(m.resetsAt) : 'Monday 00:00 PT';
  const holderLine = m.wallet
    ? `<span class="ch-wallet" title="${esc(m.wallet)}">Linked wallet ${esc(shortWallet(m.wallet))}. ${m.holderNow === null ? (m.holderError ? 'Holder entries are counted when the winner is drawn.' : 'Checking holder entries…') : `Holder entries: ${m.holderNow}.`}</span>`
    : `<span class="ch-wallet">No wallet linked yet</span>${m.showLink ? '<a class="btn primary ch-link" data-a="link-wallet" href="https://phantom.app/download">Link your wallet</a>' : ''}`;
  const shown = m.entriesNow + (m.holderNow ?? 0);
  const last = m.lastDraw ? `<p class="ch-last">${m.lastDraw.won ? 'You won' : 'You had'} ${m.lastDraw.entries} of ${m.lastDraw.total} entries in the last drawing.</p>` : '';
  const sign = m.signedIn ? '' : '<p class="note">Sign in (not as a guest) and your games count. Guests can still play.</p>';
  const err = error ? `<p class="note">${esc(error)}</p>` : '';
  return `<div class="ch">
    <p class="ch-when">Week ends ${esc(when)}. Resets every Monday at 00:00 Pacific.</p>
    ${prizeHtml()}
    ${err}${sign}
    <p class="ch-hold"><b>${esc(holderOfferText({ ...RAFFLE_DEFAULTS, pjamPerEntry: m.pjamPer, pjamCountedCap: m.countedCap }))}</b></p>
    <ul class="ch-list">${rows}</ul>
    <p class="ch-base">${m.base ? 'Base entry earned.' : 'Finish all four for 1 base entry.'} Challenge entries so far: <b>${m.entriesNow}</b>. Your entries this week: <b>${shown}</b>.</p>
    <p class="ch-bonus"><b>No purchase needed.</b> Finish the four challenges for 1 entry. Extra entries from play, up to ${m.bonusCap}: each one takes ${m.gamesPer} extra online games past the weekly goal and ${m.winsPer} online wins. You have ${m.onlineExtra} extra games and ${m.wins} wins, which is ${m.grind} grind ${m.grind === 1 ? 'entry' : 'entries'}. Holder entries add to those.</p>
    <p class="ch-odds">${holderLine} Your chance is your entries divided by everyone's entries. The prize is a Pokémon card, sent by hand. The game does not take payment or a shipping address.</p>
    ${last}
    <p class="ch-rules"><a href="raffle-rules.html" target="_blank" rel="noopener">Official rules</a></p>
    <div class="actions center"><button class="btn ghost" type="button" data-a="back">Back</button></div>
  </div>`;
}
