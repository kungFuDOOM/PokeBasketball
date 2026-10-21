// Season Draft: draft ten with the regular draft screen, auto-sim a season, then results and sharing.
import { monByDex, spriteUrl } from '../data/pokemon';
import { LEAGUE, USER_STYLE } from '../franchise/league';
import type { Audio } from '../game/audio';
import { saveDrafted } from '../season/team';
import { shareUrl, type SharedTeam } from '../season/share';
import { renderShareCard, shareOrDownload, download, fileName } from '../season/shareImage';
import { PLAYOFF_TEXT, simulateSeason, type SeasonResult, type SimInput } from '../season/sim';
import { abbr, esc, shuffle, tier } from '../util';
import { draftScreen } from './draft';
import type { Settings } from './menu';
import type { Mon } from '../data/pokemon';

export interface SeasonActions {
  menu(): void;
  /** Leave for Quick Play or Franchise with the saved team. */
  useTeam(mode: 'quick' | 'franchise'): void;
  /** A franchise save exists, so starting one with this team replaces it. */
  hasFranchise: boolean;
}

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;
const seedOf = () => crypto.getRandomValues(new Uint32Array(1))[0];

export function toShared(name: string, color: string, color2: string, mons: Mon[], r: SeasonResult): SharedTeam {
  const u = r.user;
  return { name, color, color2, dex: mons.map((m) => m.dex), w: u.w, l: u.l, rank: u.rank, teams: u.teams, seed: u.seed, playoff: u.playoff };
}

/** Starts the draft. Never saved mid-way, so it can't touch the franchise draft save. */
export function seasonMode(root: HTMLElement, settings: Settings, audio: Audio, act: SeasonActions) {
  const name = settings.teamName.trim() || 'Pallet Town';

  function draft() {
    root.className = 'screen-draft';
    window.scrollTo(0, 0);
    const teams = [
      { name, abbr: abbr(name), ...USER_STYLE, human: true },
      ...LEAGUE.map((t) => ({ ...t, human: false })),
    ];
    draftScreen(root, { teams, order: shuffle(teams.map((_, i) => i)), taken: [], rounds: 10 }, audio,
      (rosters) => simulate(rosters), act.menu, () => {});
  }

  function simulate(rosters: Mon[][]) {
    const input: SimInput = {
      seed: seedOf(),
      teams: [
        { name, abbr: abbr(name), ...USER_STYLE, roster: rosters[0] },
        ...LEAGUE.map((t, i) => ({ name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, boost: t.boost, roster: rosters[i + 1] })),
      ],
    };
    const result = simulateSeason(input);
    saveDrafted({ name, abbr: abbr(name), colors: { color: USER_STYLE.color, color2: USER_STYLE.color2 }, mons: rosters[0], record: { w: result.user.w, l: result.user.l }, rank: result.user.rank });
    ticker(input, rosters[0], result);
  }

  /** A short week-by-week animation, then the results. */
  function ticker(input: SimInput, mons: Mon[], r: SeasonResult) {
    root.className = 'screen-season';
    window.scrollTo(0, 0);
    root.innerHTML = `
      <div class="ss-wrap ss-sim">
        <div class="ball-spin" aria-hidden="true"></div>
        <h2>Simulating season…</h2>
        <p class="ss-week" role="status">Week 0 of ${r.weeks.length}</p>
        <p class="ss-rec"><b>0-0</b></p>
        <ul class="ss-feed"></ul>
      </div>`;
    const week = root.querySelector<HTMLElement>('.ss-week')!;
    const rec = root.querySelector<HTMLElement>('.ss-rec b')!;
    const feed = root.querySelector<HTMLElement>('.ss-feed')!;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let i = 0;
    let w = 0;
    const timer = window.setInterval(() => {
      if (!root.isConnected || !week.isConnected) return window.clearInterval(timer);
      const g = r.weeks[i++];
      if (g) {
        if (g.win) w++;
        week.textContent = `Week ${g.week} of ${r.weeks.length}`;
        rec.textContent = `${w}-${i - w}`;
        const opp = input.teams[g.opp];
        feed.insertAdjacentHTML('afterbegin', `<li class="${g.win ? 'win' : 'loss'}"><b>${g.win ? 'W' : 'L'}</b> ${g.home ? 'vs' : '@'} ${esc(opp.name)} <span>${g.pf}-${g.pa}</span></li>`);
        while (feed.children.length > 4) feed.lastElementChild!.remove();
      }
      if (i >= r.weeks.length + 3 || reduce) {
        window.clearInterval(timer);
        results(input, mons, r);
      }
    }, reduce ? 0 : 130);
  }

  function results(input: SimInput, mons: Mon[], r: SeasonResult) {
    root.className = 'screen-season';
    window.scrollTo(0, 0);
    const u = r.user;
    const shared = toShared(name, USER_STYLE.color, USER_STYLE.color2, mons, r);
    const url = shareUrl(shared);
    const pots = r.players[r.pots];
    const t = (i: number) => input.teams[i];
    const playoffGames = r.playoffs.map((g) => `<li><span>${g.round === 'final' ? 'Final' : 'Semi'}</span> ${esc(t(g.a).abbr)} ${g.sa} - ${g.sb} ${esc(t(g.b).abbr)} <b>${esc(t(g.winner).abbr)}</b></li>`).join('');
    root.innerHTML = `
      <div class="ss-wrap">
        <header class="ss-head" style="--tc:${USER_STYLE.color}">
          <div>
            <p class="eyebrow">Season Draft · Final</p>
            <h2>${esc(name)}</h2>
            <p class="ss-po ${u.playoff}">${PLAYOFF_TEXT[u.playoff]}</p>
          </div>
          <div class="ss-grade" aria-label="Grade ${u.grade}"><small>Grade</small><b>${u.grade}</b></div>
        </header>
        <section class="ss-hero">
          <div class="ss-big"><b>${u.w}-${u.l}</b><span>${ordinal(u.rank)} of ${u.teams}${u.seed ? ` · #${u.seed} seed` : ''}</span></div>
          <ul class="ss-stats">
            <li><b>${u.ppg}</b><span>PPG</span></li>
            <li><b>${u.oppg}</b><span>Opp PPG</span></li>
            <li><b>${u.ppg - u.oppg >= 0 ? '+' : ''}${Math.round((u.ppg - u.oppg) * 10) / 10}</b><span>Margin</span></li>
            <li><b>${u.ovr}</b><span>Team OVR</span></li>
          </ul>
        </section>
        <div class="ss-cols">
          <section class="card ss-pots t-${tier(pots.ovr)}">
            <p class="eyebrow">Player of the Season</p>
            <div class="ss-pots-row">
              <img src="${spriteUrl(pots.dex)}" alt="">
              <div>
                <h3>${esc(pots.name)}</h3>
                <p class="note">${pots.pos} · ${pots.ovr} OVR</p>
                <p class="ss-line"><b>${pots.ppg}</b> PPG · <b>${pots.rpg}</b> RPG · <b>${pots.apg}</b> APG · <b>${pots.spg}</b> SPG · <b>${pots.bpg}</b> BPG</p>
              </div>
            </div>
          </section>
          <section class="card">
            <p class="eyebrow">Playoffs</p>
            ${r.playoffs.length ? `<ul class="ss-po-list">${playoffGames}</ul>` : ''}
            <p class="note">${u.seed ? `You earned the #${u.seed} seed.` : 'The top four of ten make the playoffs.'}</p>
          </section>
        </div>
        <section class="card">
          <p class="eyebrow">Standings</p>
          <table class="ss-table">
            <thead><tr><th>#</th><th>Team</th><th>W-L</th><th>PF</th><th>PA</th></tr></thead>
            <tbody>${r.standings.map((s) => `
              <tr class="${s.team === 0 ? 'me' : ''} ${s.rank <= 4 ? 'po' : ''}" style="--tc:${s.color}">
                <td>${s.rank}</td><td><i></i>${esc(s.name)}</td><td>${s.w}-${s.l}</td><td>${Math.round(s.pf / (s.w + s.l))}</td><td>${Math.round(s.pa / (s.w + s.l))}</td>
              </tr>`).join('')}</tbody>
          </table>
        </section>
        <section class="card">
          <p class="eyebrow">Your ten</p>
          <ul class="ss-roster">${r.players.map((p) => `
            <li class="${p.starter ? 'starter' : ''}" title="${esc(p.name)}"><img src="${spriteUrl(p.dex)}" alt=""><span>${esc(p.name)}</span><small>${p.pos} · ${p.ppg} PPG</small></li>`).join('')}</ul>
        </section>
        <section class="card ss-share">
          <p class="eyebrow">Share</p>
          <div class="actions">
            <button class="btn primary" data-a="image">Share image</button>
            <button class="btn" data-a="copy">Copy link</button>
          </div>
          <input class="ss-link" readonly value="${esc(url)}" aria-label="Share link">
          <p class="note ss-status" role="status"></p>
        </section>
        <div class="actions center ss-actions">
          <button class="btn primary big" data-go="season-again">Play again</button>
          <button class="btn big" data-go="season-use">Use this team</button>
          <button class="btn ghost big" data-go="menu">Back to menu</button>
        </div>
        <div class="actions center ss-use" hidden>
          <button class="btn" data-go="use-quick">Quick Play with this team</button>
          <button class="btn" data-go="use-franchise">${act.hasFranchise ? 'Franchise (replaces your save)' : 'Start a franchise'}</button>
        </div>
      </div>`;
    const status = root.querySelector<HTMLElement>('.ss-status')!;
    const link = root.querySelector<HTMLInputElement>('.ss-link')!;
    const say = (s: string) => (status.textContent = s);
    link.addEventListener('focus', () => link.select());
    root.querySelector('.ss-wrap')!.addEventListener('click', async (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-a], [data-go]');
      if (!el) return;
      const a = el.dataset.a;
      const go = el.dataset.go;
      if (a === 'image') {
        say('Drawing your card…');
        try {
          const done = await shareOrDownload(await renderShareCard(shared), shared);
          say(done === 'shared' ? 'Shared!' : done === 'downloaded' ? `Saved ${fileName(shared)}` : '');
        } catch { say('Could not make the image on this browser.'); }
      } else if (a === 'copy') {
        try {
          await navigator.clipboard.writeText(url);
          say('Link copied.');
        } catch {
          link.focus();
          link.select();
          say(document.execCommand?.('copy') ? 'Link copied.' : 'Press Ctrl+C (or long-press) to copy the link.');
        }
      } else if (go === 'season-again') draft();
      else if (go === 'menu') act.menu();
      else if (go === 'season-use') {
        root.querySelector<HTMLElement>('.ss-use')!.hidden = false;
        say('Saved as My Drafted Team. Pick where to use it.');
      } else if (go === 'use-quick') act.useTeam('quick');
      else if (go === 'use-franchise') {
        if (act.hasFranchise && !el.classList.contains('warn')) {
          el.classList.add('warn');
          el.textContent = 'Tap again to replace your franchise';
          return;
        }
        act.useTeam('franchise');
      }
    });
  }

  draft();
}

/** The card someone's share link opens to. */
export function sharedScreen(root: HTMLElement, s: SharedTeam, act: { draftOwn(): void; menu(): void }) {
  root.className = 'screen-season';
  window.scrollTo(0, 0);
  root.innerHTML = `
    <div class="ss-wrap ss-shared">
      <header class="ss-head" style="--tc:${s.color}">
        <div>
          <p class="eyebrow">Season Draft · Shared team</p>
          <h2>${esc(s.name)}</h2>
          <p class="ss-po ${s.playoff}">${PLAYOFF_TEXT[s.playoff]}</p>
        </div>
      </header>
      <section class="ss-hero">
        <div class="ss-big"><b>${s.w}-${s.l}</b><span>${ordinal(s.rank)} of ${s.teams}${s.seed ? ` · #${s.seed} seed` : ''}</span></div>
      </section>
      <section class="card">
        <ul class="ss-roster">${s.dex.map((d) => { const m = monByDex(d); return `
          <li title="${esc(m.name)}"><img src="${spriteUrl(d)}" alt=""><span>${esc(m.name)}</span><small>${m.pos} · ${m.ovr} OVR</small></li>`; }).join('')}</ul>
      </section>
      <div class="actions center ss-actions">
        <button class="btn primary big" data-go="draft-own">Draft your own</button>
        <button class="btn ghost big" data-go="menu">Back to menu</button>
      </div>
      <p class="note center"><button class="link-btn" data-go="save-img">Download this card as an image</button></p>
    </div>`;
  root.querySelector('.ss-wrap')!.addEventListener('click', async (e) => {
    const go = (e.target as HTMLElement).closest<HTMLElement>('[data-go]')?.dataset.go;
    if (go === 'draft-own') act.draftOwn();
    else if (go === 'menu') act.menu();
    else if (go === 'save-img') await download(await renderShareCard(s), fileName(s));
  });
}
