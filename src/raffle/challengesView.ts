// The weekly challenges screen. Pure HTML. Progress comes from pokejam_raffle_me; this file does not count games.
import { esc } from '../util';
import { RAFFLE_DEFAULTS, configFromJson, scoreRaffle, type RaffleConfig } from './entries';
import type { RaffleMe } from './client';

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
  /** Entries before the draw reads the wallet. Holder entries are added then, up to the cap. */
  entriesNow: number;
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
    wallet: null, entriesNow: 0, lastDraw: null,
  };
}

export const resetLabel = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Monday 00:00 PT';
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
};

const shortWallet = (w: string) => (w.length <= 12 ? w : `${w.slice(0, 4)}…${w.slice(-4)}`);

const amount = (n: number) => n.toLocaleString('en-US');

/** The screen body. Every string from the server is escaped. */
export function challengesHtml(m: ChallengeModel, error?: string | null): string {
  const rows = m.rows.map((r) => `<li class="${r.done ? 'done' : ''}"><span><b>${esc(r.label)}</b><small>${esc(r.detail ?? '')}</small></span><strong>${r.done ? 'Done' : `${r.have}/${r.need}`}</strong></li>`).join('');
  const when = m.resetsAt ? resetLabel(m.resetsAt) : 'Monday 00:00 PT';
  const wallet = m.wallet ? `<span class="ch-wallet" title="${esc(m.wallet)}">Linked wallet ${esc(shortWallet(m.wallet))}</span>` : '<span class="ch-wallet">No wallet linked yet</span>';
  const last = m.lastDraw ? `<p class="ch-last">${m.lastDraw.won ? 'You won' : 'You had'} ${m.lastDraw.entries} of ${m.lastDraw.total} entries in the last drawing.</p>` : '';
  const sign = m.signedIn ? '' : '<p class="note">Sign in (not as a guest) and your games count. Guests can still play.</p>';
  const err = error ? `<p class="note">${esc(error)}</p>` : '';
  return `<div class="ch">
    <p class="ch-when">Week ends ${esc(when)}. Resets every Monday at 00:00 Pacific.</p>
    ${err}${sign}
    <ul class="ch-list">${rows}</ul>
    <p class="ch-base">${m.base ? 'Base entry earned.' : 'Finish all four for 1 base entry.'} Entries so far, before the wallet check: <b>${m.entriesNow}</b>.</p>
    <p class="ch-bonus"><b>No purchase needed.</b> Bonus entries, up to ${m.bonusCap} (so ${m.bonusCap + 1} total): hold ${amount(m.pjamPer)} PJAM in your linked wallet at the draw (1 entry each, checked on the server), or earn the same entries by play. Each one takes ${m.gamesPer} extra online games past the weekly goal and ${m.winsPer} online wins. You have ${m.onlineExtra} extra games and ${m.wins} wins, which is ${m.grind} grind ${m.grind === 1 ? 'entry' : 'entries'}. Holding and grinding add together, then stop at ${m.bonusCap}.</p>
    <p class="ch-odds">${wallet} Your chance is your entries divided by everyone's entries. The prize is a Pokémon card, sent by hand. The game does not take payment or a shipping address.</p>
    ${last}
    <p class="ch-rules"><a href="raffle-rules.html" target="_blank" rel="noopener">Official rules</a></p>
    <div class="actions center"><button class="btn ghost" type="button" data-a="back">Back</button></div>
  </div>`;
}
