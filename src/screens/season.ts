// Season Draft: draft ten with the regular draft screen, auto-sim a season, then results and sharing.
import { monByDex, spriteUrl } from '../data/pokemon';
import { LEAGUE, USER_STYLE } from '../franchise/league';
import type { Audio } from '../game/audio';
import { renameDrafted, saveDrafted } from '../season/team';
import { inlineRename } from '../ui/teamName';
import { confirmNewDraft } from '../ui/newDraft';
import { shareUrl, type SharedTeam } from '../season/share';
import { renderCard, renderShareCard, shareTeam, toPngBlob, download, fileName } from '../season/shareImage';
import { teamGrade } from '../season/grade';
import { PLAYOFF_TEXT, simulateSeason, type SeasonResult, type SimInput } from '../season/sim';
import { abbr, esc, lettersName, shuffle, tier } from '../util';
import { bestLineup } from '../game/game';
import { draftScreen, type DraftTeam } from './draft';
import type { Settings } from './menu';
import type { Mon } from '../data/pokemon';
import { offlineStats } from '../telemetry/offlineStats';

/** Season results as the offline stats' playoff_round. */
const PLAYOFF_ROUND = { missed: 0, semis: 1, final: 2, champion: 3 } as const;

export interface SeasonActions {
  menu(): void;
  /** Leave for Quick Play or Franchise with the saved team. */
  useTeam(mode: 'quick' | 'franchise'): void;
}

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;
const seedOf = () => crypto.getRandomValues(new Uint32Array(1))[0];

export function toShared(name: string, color: string, color2: string, mons: Mon[], r: SeasonResult): SharedTeam {
  const u = r.user;
  const allStars = r.allStars.filter((a) => a.team === 0).length;
  return { name, color, color2, dex: mons.map((m) => m.dex), w: u.w, l: u.l, rank: u.rank, teams: u.teams, seed: u.seed, playoff: u.playoff, ...(allStars ? { allStars } : {}) };
}

/**
 * The draft is done: sim the season and only now save the team as My Drafted Team, replacing any older one.
 * Nothing before this point writes the saved team, so quitting a new draft midway keeps the old team.
 */
export function finishSeasonDraft(user: Pick<DraftTeam, 'name' | 'abbr' | 'color' | 'color2'>, rosters: Mon[][], seed: number) {
  const input: SimInput = {
    seed,
    teams: [
      { name: user.name, abbr: user.abbr, color: user.color, color2: user.color2, roster: rosters[0] },
      ...LEAGUE.map((t, i) => ({ name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, boost: t.boost, roster: rosters[i + 1] })),
    ],
  };
  const result = simulateSeason(input);
  saveDrafted({ name: user.name, abbr: user.abbr, colors: { color: user.color, color2: user.color2 }, mons: rosters[0], record: { w: result.user.w, l: result.user.l }, rank: result.user.rank });
  return { input, result };
}

/** Starts the draft. Never saved mid-way, so it can't touch the franchise draft save. */
export function seasonMode(root: HTMLElement, settings: Settings, audio: Audio, act: SeasonActions) {
  const defaultName = lettersName(settings.teamName) || 'Pallet Town';
  /** The human team. The draft summary can rename and recolor it, so everything after the draft reads from here. */
  let user: DraftTeam = { name: defaultName, abbr: abbr(defaultName), ...USER_STYLE, human: true };

  function draft() {
    root.className = 'screen-draft';
    window.scrollTo(0, 0);
    user = { name: defaultName, abbr: abbr(defaultName), ...USER_STYLE, human: true };
    const teams: DraftTeam[] = [
      user,
      ...LEAGUE.map((t) => ({ ...t, human: false })),
    ];
    draftScreen(root, { teams, order: shuffle(teams.map((_, i) => i)), taken: [], rounds: 10 }, audio,
      (rosters) => simulate(rosters), act.menu, () => {});
  }

  function simulate(rosters: Mon[][]) {
    const { input, result } = finishSeasonDraft(user, rosters, seedOf());
    offlineStats().season('season_draft', null, PLAYOFF_ROUND[result.user.playoff]);
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
    let shared = toShared(user.name, user.color, user.color2, mons, r);
    let url = shareUrl(shared);
    const pots = r.players[r.pots];
    const t = (i: number) => input.teams[i];
    // The whole ten, starters (by position) then bench, right under the record.
    // Same by-position rule as the sim and the draft screen: one starter per slot, in slot order.
    const lineup = bestLineup(mons);
    const statOf = (m: Mon) => r.players.find((p) => p.dex === m.dex)!;
    const starters = lineup.starters.map((m, k) => ({ ...statOf(m), slot: lineup.slots[k] }));
    const bench = lineup.bench.map((m) => ({ ...statOf(m), slot: m.pos }));
    const teamRow = (label: string, ps: typeof starters) => `
      <p class="ss-team-lbl">${label}</p>
      <ul class="ss-team-grid ${label === 'Bench' ? 'bench' : ''}">${ps.map((p) => `
        <li class="t-${tier(p.ovr)}" title="${esc(p.name)} · ${p.pos}${p.slot !== p.pos ? ` covering ${p.slot}` : ''} · ${p.ovr} OVR · ${p.ppg} PPG">
          <span class="tm-pos">${p.slot}</span><span class="tm-ovr">${p.ovr}</span>
          <img src="${spriteUrl(p.dex)}" alt="">
          <span class="tm-nm">${esc(p.name)}</span>
        </li>`).join('')}</ul>`;
    const mineAS = r.allStars.filter((a) => a.team === 0).length;
    const playoffGames = r.playoffs.map((g) => `<li><span>${g.round === 'final' ? 'Final' : 'Semi'}</span> ${esc(t(g.a).abbr)} ${g.sa} - ${g.sb} ${esc(t(g.b).abbr)} <b>${esc(t(g.winner).abbr)}</b></li>`).join('');
    root.innerHTML = `
      <div class="ss-wrap">
        <header class="ss-head" style="--tc:${user.color}">
          <div>
            <p class="eyebrow">Season Draft · Final</p>
            <h2 class="ss-name"></h2>
            <p class="ss-po ${u.playoff}">${PLAYOFF_TEXT[u.playoff]}</p>
          </div>
          <div class="ss-grade" aria-label="Draft grade ${u.grade}"><small>Draft grade</small><b>${u.grade}</b></div>
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
        <section class="ss-team" aria-label="Your team">
          ${teamRow('Starters', starters)}
          ${teamRow('Bench', bench)}
        </section>
        <section class="ss-next" aria-label="What next">
          <div class="ss-next-btns">
            <button class="btn primary big" data-go="use-quick">Quick Play with this team</button>
            <button class="btn primary big" data-go="use-franchise">Franchise with this team</button>
            <div class="ss-share-cell">
              <button class="ss-thumb" data-a="preview" aria-label="See the share card full size" title="What you'll share">
                <span class="ss-thumb-ph">Drawing card…</span>
              </button>
              <button class="btn primary big ss-share-btn" data-a="share">Share my team</button>
            </div>
          </div>
          <p class="note ss-next-note">Saved as My Drafted Team: your best five start, the other five come off the bench. Tap your team name to rename it.</p>
          <p class="note ss-status" role="status"></p>
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
        <section class="card ss-allstars" aria-label="All-Stars">
          <p class="eyebrow">All-Stars</p>
          <p class="note ss-as-line">${mineAS === 0 ? 'None of your players made the All-Star team.' : mineAS === 1 ? '1 of your players made the All-Star team.' : `${mineAS} of your players made the All-Star team.`}</p>
          <ul class="ss-as-grid">${r.allStars.map((a) => `
            <li class="${a.team === 0 ? 'mine' : ''}" style="--tc:${a.team === 0 ? user.color : a.color}">
              ${a.team === 0 ? '<span class="as-you">YOUR TEAM</span>' : ''}
              <span class="as-slot">${a.slot}</span>
              <img src="${spriteUrl(a.dex)}" alt="">
              <b class="as-nm">${esc(a.name)}</b>
              <span class="as-team"><i></i>${esc(a.team === 0 ? user.name : a.teamName)}</span>
              <small><span>${a.ppg} PPG · ${a.rpg} RPG</span> <span>${a.apg} APG${a.bpg >= 1 ? ` · ${a.bpg} BPG` : a.spg >= 1 ? ` · ${a.spg} SPG` : ''}</span></small>
            </li>`).join('')}</ul>
        </section>
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
        <section class="card ss-share">
          <p class="eyebrow">Share link</p>
          <div class="ss-link-row">
            <input class="ss-link" readonly value="${esc(url)}" aria-label="Share link">
            <button class="btn" data-a="copy">Copy</button>
          </div>
        </section>
        <div class="actions center ss-actions">
          <button class="btn primary big" data-go="season-again">Play again</button>
          <button class="btn ghost big" data-go="menu">Back to menu</button>
        </div>
      </div>`;
    const status = root.querySelector<HTMLElement>('.ss-status')!;
    const link = root.querySelector<HTMLInputElement>('.ss-link')!;
    const say = (s: string) => (status.textContent = s);
    link.addEventListener('focus', () => link.select());
    // Draw the share card now, so tapping "Share my team" can open the share sheet straight away.
    const drawCard = async () => { const canvas = await renderShareCard(shared); return { canvas, blob: await toPngBlob(canvas) }; };
    let card: ReturnType<typeof drawCard> | null = null;
    let cardUrl = '';
    const thumb = root.querySelector<HTMLElement>('.ss-thumb')!;
    const refreshCard = () => {
      cardUrl = '';
      thumb.hidden = false;
      thumb.innerHTML = '<span class="ss-thumb-ph">Drawing card…</span>';
      const mine = (card = drawCard());
      mine.then(({ canvas }) => {
        if (card !== mine) return; // renamed again while drawing
        // A data: URL, because the site's CSP allows data: images but not blob: ones.
        cardUrl = canvas.toDataURL('image/png');
        thumb.innerHTML = `<img src="${cardUrl}" alt="Your share card">`;
      }).catch(() => { if (card === mine) { card = null; thumb.hidden = true; } });
    };
    refreshCard();
    // Rename: the header, standings, saved team, share link and share card all follow the new name.
    inlineRename(root.querySelector<HTMLElement>('.ss-name')!, () => user.name, (name) => {
      user.name = name;
      user.abbr = abbr(name);
      renameDrafted(name);
      shared = { ...shared, name };
      url = shareUrl(shared);
      link.value = url;
      const row = root.querySelector<HTMLElement>('.ss-table tr.me td:nth-child(2)');
      if (row) row.innerHTML = `<i></i>${esc(name)}`;
      root.querySelectorAll('.ss-as-grid li.mine .as-team').forEach((el) => (el.innerHTML = `<i></i>${esc(name)}`));
      refreshCard();
      say(`Renamed to ${name}. Your share card is updated.`);
    });
    const preview = () => {
      if (!cardUrl) return;
      const el = document.createElement('div');
      el.className = 'ss-preview';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Share card');
      el.innerHTML = `<img src="${cardUrl}" alt="Your share card"><p class="note">Tap anywhere to close</p>`;
      const close = () => { el.remove(); window.removeEventListener('keydown', onKey); };
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
      el.addEventListener('click', close);
      window.addEventListener('keydown', onKey);
      document.body.appendChild(el);
    };
    root.querySelector('.ss-wrap')!.addEventListener('click', async (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-a], [data-go]');
      if (!el) return;
      const a = el.dataset.a;
      const go = el.dataset.go;
      if (a === 'preview') preview();
      else if (a === 'share') {
        try {
          if (!card) say('Drawing your card…');
          const { canvas, blob } = await (card ?? (card = drawCard()));
          const done = await shareTeam(canvas, blob, shared, url);
          say(done === 'shared' ? 'Shared!' : done === 'saved+copied' ? 'Link copied, image saved' : done === 'saved' ? 'Image saved. Copy the link below.' : '');
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
      } else if (go === 'season-again') {
        // The team on this screen is the saved one: warn before a new draft would replace it.
        void confirmNewDraft().then((c) => {
          if (c === 'new') draft();
          else if (c === 'quick') act.useTeam('quick');
          else if (c === 'franchise') act.useTeam('franchise');
        });
      }
      else if (go === 'menu') act.menu();
      else if (go === 'use-quick') act.useTeam('quick');
      // The name confirm (with the replace-save warning when there is a save) comes from the franchise start itself.
      else if (go === 'use-franchise') act.useTeam('franchise');
    });
  }

  draft();
}

/** The card someone's share link opens to. */
export function sharedScreen(root: HTMLElement, s: SharedTeam, act: { draftOwn(): void; menu(): void }) {
  root.className = 'screen-season';
  window.scrollTo(0, 0);
  const mons = s.dex.map((d) => monByDex(d));
  const { grade, ovr } = teamGrade(mons);
  const lineup = bestLineup(mons);
  const tile = (m: Mon, slot: string) => `
        <li class="t-${tier(m.ovr)}" title="${esc(m.name)} · ${m.pos} · ${m.ovr} OVR">
          <span class="tm-pos">${slot}</span><span class="tm-ovr">${m.ovr}</span>
          <img src="${spriteUrl(m.dex)}" alt="">
          <span class="tm-nm">${esc(m.name)}</span>
        </li>`;
  // A team shared from a draft-complete screen has no season: show the grade and OVR instead of a record.
  const hero = s.noRecord
    ? `<div class="ss-big"><b>${ovr} OVR</b><span>Fresh off the draft · no season played yet</span></div>`
    : `<div class="ss-big"><b>${s.w}-${s.l}</b><span>${ordinal(s.rank)} of ${s.teams}${s.seed ? ` · #${s.seed} seed` : ''}${s.allStars ? ` · ★ ${s.allStars} All-Star${s.allStars > 1 ? 's' : ''}` : ''}</span></div>`;
  root.innerHTML = `
    <div class="ss-wrap ss-shared">
      <header class="ss-head" style="--tc:${s.color}">
        <div>
          <p class="eyebrow">${s.noRecord ? 'Draft' : 'Season Draft'} · Shared team</p>
          <h2>${esc(s.name)}</h2>
          ${s.noRecord ? '' : `<p class="ss-po ${s.playoff}">${PLAYOFF_TEXT[s.playoff]}</p>`}
        </div>
        <div class="ss-grade" aria-label="Draft grade ${grade}"><small>Draft grade</small><b>${grade}</b></div>
      </header>
      <section class="ss-hero">${hero}</section>
      <section class="ss-team" aria-label="Their team">
        <p class="ss-team-lbl">Starters</p>
        <ul class="ss-team-grid">${lineup.starters.map((m, k) => tile(m, lineup.slots[k])).join('')}</ul>
        ${lineup.bench.length ? `<p class="ss-team-lbl">Bench</p><ul class="ss-team-grid bench">${lineup.bench.map((m) => tile(m, m.pos)).join('')}</ul>` : ''}
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
    else if (go === 'save-img') await download(await renderCard(s), fileName(s));
  });
}
