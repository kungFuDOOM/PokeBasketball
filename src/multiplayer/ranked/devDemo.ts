// Dev only (main.ts imports this under import.meta.env.DEV): ?ranked=1&rankeddemo=<screen> shows a Ranked screen with made-up
// data, for screenshots and layout checks. It never talks to a server and is not in a production bundle.
import { panel } from '../shared/matchFlow';
import type { ReportOutcome } from '../shared/matchService';
import type { PhantomAction } from '../../wallet/phantom';
import type { RankedMe, RankedResult } from './serverRank';
import { renderRankBadge } from '../../ranked/badge';
import { postMatchHtml, rankChipHtml, signInPanelHtml, usernamePickerHtml } from './view';
import { profileHtml, type ProfileModel } from '../../screens/profile';
import { checkUsername, nameErrorText } from './username';

const me = (o: Partial<RankedMe> = {}): RankedMe => ({
  season: 1, daysLeft: 31, placing: false, placementsPlayed: 5, divIdx: 7, points: 40, zenith: false, shieldCharge: 1, shieldLossesLeft: null,
  shieldActive: true, wins: 12, losses: 9, cooldownUntil: null, ...o,
});
const result = (o: Partial<RankedResult> = {}): RankedResult => ({
  placing: false, event: null, placementsPlayed: 5, before: 740, after: 762, delta: 22, divIdx: 7, points: 62, ...o,
});
const out = (r: RankedResult, m: RankedMe | null, oppRank: ReportOutcome['oppRank'] = { divIdx: 10 }): ReportOutcome => ({ queue: 'ranked', status: 'done', result: r, me: m ?? undefined, names: { me: 'Ash_Ketchum', opp: 'Misty_Waterflower' }, oppRank });

const HOME_BTNS = '<button class="btn primary big" data-a="find">Find ranked match</button><button class="btn" data-a="cpu">Practice vs CPU (unranked)</button><button class="btn ghost" data-a="back">Back</button>';
const home = (chip: string) => panel('RANKED', 'Play 5 placement matches to earn a rank.', `<div class="rk-home"><div class="rk-left">${chip}</div><div class="rk-right">${HOME_BTNS}</div></div>`);
const signIn = (a: PhantomAction) => panel('RANKED', 'Play 5 placement matches to earn a rank.',
  `<div class="rk-home"><div class="rk-left">${signInPanelHtml(a)}</div><div class="rk-right"><button class="btn" data-a="cpu">Practice vs CPU (unranked)</button><button class="btn ghost" data-a="back">Back</button></div></div>`);
const post = (html: string) => `<div class="menu"><section class="card setup"><div class="mp-outcome" data-outcome>${html}</div></section></div>`;

const model = (o: Partial<ProfileModel> = {}): ProfileModel => ({
  rankedOn: true, onlineAvailable: true, signedIn: true, username: 'Ash_Ketchum', nextChangeAt: null, me: me({ peakIdx: 9, wins: 31, losses: 24 }),
  social: { played: 18, won: 11 }, local: { franchise: 'Pallet Town · Season 2 · 6-3', drafted: 'Pallet Town · 7-3 · #12' }, ...o,
});
const profile = (m: ProfileModel) => panel('PROFILE', m.signedIn ? 'Your record' : 'Your record on this device', profileHtml(m, { kind: 'install', href: 'https://phantom.app/download' }));
const BAD_NAME = 'Admin_Joe';

const SCREENS: Record<string, () => string> = {
  chip: () => home(rankChipHtml(me())),
  'chip-zenith': () => home(rankChipHtml(me({ divIdx: 24, points: 340, zenith: true, shieldActive: false }))),
  'chip-shield-spent': () => home(rankChipHtml(me({ shieldCharge: 0, shieldLossesLeft: 2 }))),
  placing: () => home(rankChipHtml(me({ placing: true, placementsPlayed: 2, divIdx: null, points: null }))),
  signin: () => signIn({ kind: 'install', href: 'https://phantom.app/download' }),
  'signin-phantom': () => signIn({ kind: 'sign-in' }),
  'signin-mobile': () => signIn({ kind: 'open-in-phantom', href: 'https://phantom.app/ul/browse/x?ref=y' }),
  'profile-signedin': () => profile(model()),
  'profile-placing': () => profile(model({ me: me({ placing: true, placementsPlayed: 2, divIdx: null, points: null }) })),
  'profile-guest': () => profile(model({ signedIn: false, username: null, me: null, social: { played: 3, won: 1 } })),
  'username-error': () => panel('RANKED', 'Play 5 placement matches to earn a rank.',
    `<div class="rk-home"><div class="rk-left">${usernamePickerHtml({ value: BAD_NAME, error: nameErrorText(checkUsername(BAD_NAME) ?? 'profanity') })}</div><div class="rk-right"><button class="btn ghost" data-a="back">Back</button></div></div>`),
  'profile-zenith': () => profile(model({ me: me({ divIdx: 24, points: 340, zenith: true, peakIdx: 24, shieldActive: false }) })),
  'post-opp-unranked': () => post(postMatchHtml(out(result(), me({ points: 62 }), null), true)),
  'post-opp-placing': () => post(postMatchHtml(out(result(), me({ points: 62 }), { placing: 3 }), true)),
  badges: () => panel('BADGES', 'Every tier, then Zenith, placement and unranked', `<div class="rk-gallery">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map((d) => renderRankBadge({ divIdx: d })).join('')}${renderRankBadge({ placing: 2 })}${renderRankBadge(null)}</div>`),
  'post-win': () => post(postMatchHtml(out(result(), me({ points: 62 })), true)),
  'post-loss': () => post(postMatchHtml(out(result({ before: 762, after: 745, delta: -17, points: 45 }), me({ points: 45 })), false)),
  'post-up': () => post(postMatchHtml(out(result({ event: 'promoted', before: 790, after: 812, delta: 22, divIdx: 8, points: 12 }), me({ divIdx: 8, points: 12 })), true)),
  'post-down': () => post(postMatchHtml(out(result({ event: 'demoted', before: 805, after: 778, delta: -27, divIdx: 7, points: 78 }), me({ divIdx: 7, points: 78, shieldCharge: 0, shieldLossesLeft: 3 })), false)),
  'post-shield': () => post(postMatchHtml(out(result({ event: 'shielded', before: 700, after: 700, delta: -19, divIdx: 7, points: 0 }), me({ divIdx: 7, points: 0, shieldCharge: 0, shieldLossesLeft: 3 })), false)),
  'post-placing': () => post(postMatchHtml(out(result({ placing: true, placementsPlayed: 3, before: null, after: null, delta: null, divIdx: null, points: null }), null), true)),
  'post-placed': () => post(postMatchHtml(out(result({ placing: true, event: 'placed', placementsPlayed: 5, before: 400, after: 440, delta: 40, divIdx: 4, points: 40 }), me({ divIdx: 4, points: 40 })), true)),
};

export const devRankedScreen = (): string | null => {
  const k = new URLSearchParams(location.search).get('rankeddemo');
  return k && k in SCREENS ? k : null;
};

export function devRanked(root: HTMLElement, kind: string) {
  root.className = kind.startsWith('post') ? 'screen-results' : 'screen-menu';
  root.innerHTML = SCREENS[kind]();
  // The reveal's Skip button (index.ts binds it for real play).
  root.addEventListener('click', (e) => (e.target as Element).closest('[data-rk-skip]')?.closest('.rk-anim')?.classList.add('skipped'));
}
