import { POSITIONS, monByDex, spriteUrl } from '../data/pokemon';
import {
  badgesEarned, canSign, finalWeek, venueOf, monOf, perGame, sign, standings, teamOvrOf, userGame, weekGames, weekLabel,
  xpToNext, type FGame, type FTeam, type Franchise,
} from '../franchise/league';
import { badgeSvg } from '../ui/badges';
import { esc, tier } from '../util';
import { bindSettings, settingsHtml, type Settings } from './menu';
import { typeChips } from './draft';

export interface HubActions {
  play(g: FGame): void;
  simMine(g: FGame): void;
  simWeek(): void;
  nextSeason(): void;
  menu(): void;
  /** Franchise or settings changed and should be saved. */
  saved(): void;
}

const ordinal = (n: number) => {
  const sfx = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (sfx[(v - 20) % 10] || sfx[v] || sfx[0]);
};
const rec = (t: FTeam) => `${t.w}-${t.l}`;
const fmt = (v: number) => v.toFixed(1);

const byPos = (f: Franchise, roster: string[]) =>
  [...roster].sort((a, b) => POSITIONS.indexOf(monOf(f, a).pos) - POSITIONS.indexOf(monOf(f, b).pos));

function lineup(f: Franchise, t: FTeam): string {
  return `<ul class="lineup">${byPos(f, t.roster).map((u) => {
    const m = monOf(f, u);
    return `<li title="${esc(m.name)}"><img src="${spriteUrl(m.dex)}" alt=""><span>${m.pos}</span><b class="t-${tier(m.ovr)}">${m.ovr}</b></li>`;
  }).join('')}</ul>`;
}

function nextCard(f: Franchise, settings: Settings): string {
  if (f.phase === 'done') {
    const champ = f.teams[f.champion!];
    const mvp = f.mvp ? f.players[f.mvp] : null;
    const mvpTeam = mvp && f.teams.find((t) => t.roster.includes(mvp.uid));
    const pg = mvp && perGame(mvp.stats);
    return `
      <section class="card next champ" style="--tc:${champ.color}">
        <p class="eyebrow">Season ${f.season} champions</p>
        <h2>${champ.human ? 'You won the title!' : esc(champ.name)}</h2>
        ${lineup(f, champ)}
        ${mvp && pg ? `<div class="mvp"><img src="${spriteUrl(mvp.dex)}" alt=""><div><span class="lbl">Season MVP</span><strong>${esc(monByDex(mvp.dex).name)}</strong><span>${esc(mvpTeam?.name ?? '')} · ${fmt(pg.ppg)} PPG · ${fmt(pg.rpg)} RPG · ${fmt(pg.apg)} APG</span></div></div>` : ''}
        <p class="note">Your roster, levels and evolutions carry over. Records and stats reset.</p>
        <div class="actions"><button class="btn primary big" data-a="next-season">Start Season ${f.season + 1}</button></div>
      </section>`;
  }
  const g = userGame(f);
  if (!g) {
    const played = weekGames(f).some((x) => (x.home === 0 || x.away === 0) && x.score);
    const inPlayoffs = f.games.some((x) => x.round && (x.home === 0 || x.away === 0));
    const label = played
      ? 'Your game is in the books'
      : f.phase === 'playoffs'
        ? (inPlayoffs ? 'You were knocked out. The final goes on without you.' : 'You missed the playoffs. The top four play on.')
        : 'Bye week';
    const btn = played ? 'Finish the week' : f.week === finalWeek(f) ? 'Sim the final' : f.phase === 'playoffs' ? 'Sim the semifinals' : 'Sim the week';
    return `
      <section class="card next">
        <p class="eyebrow">${weekLabel(f)}</p>
        <h2>${esc(label)}</h2>
        <div class="actions"><button class="btn primary big" data-a="sim-week">${btn}</button></div>
      </section>`;
  }
  const home = f.teams[g.home];
  const away = f.teams[g.away];
  const side = (t: FTeam, where: string) => `
    <div class="nx-team" style="--tc:${t.color}">
      <span class="where">${where}${t.gym ? ` · Gym ${t.gym}` : t.elite ? ' · Final boss' : ''}</span>
      <h3>${esc(t.name)}</h3>
      ${t.leader && !t.human ? `<p class="leader">${t.elite ? '' : 'Gym Leader '}${esc(t.leader)}${t.badge ? ` · ${esc(t.badge)} Badge on the line` : ''}</p>` : ''}
      <p>${g.round ? '' : `${rec(t)} · `}${teamOvrOf(f, t)} OVR</p>
      ${lineup(f, t)}
    </div>`;
  const title = g.round === 'final' ? 'The Final' : g.round === 'semi' ? 'Semifinal' : weekLabel(f);
  return `
    <section class="card next">
      <p class="eyebrow">${title}${g.round ? ' · win or go home' : ''} · ${esc(venueOf(f, g.home).venue)}</p>
      <div class="nx-cols">${side(home, 'Home')}<div class="vs">VS</div>${side(away, 'Away')}</div>
      ${settingsHtml(settings)}
      <div class="actions center">
        <button class="btn primary big" data-a="play">Play game</button>
        <button class="btn" data-a="sim-mine">Sim game</button>
      </div>
    </section>`;
}

function badgeCaseHtml(f: Franchise): string {
  const gyms = f.teams.filter((t) => t.gym).sort((a, b) => a.gym! - b.gym!);
  if (!gyms.length) return '';
  const earned = badgesEarned(f);
  const elite = f.teams.find((t) => t.elite);
  const count = gyms.filter((t) => earned.has(t.id)).length;
  const slot = (t: FTeam, name: string, label: string) => `
    <li class="${earned.has(t.id) ? 'got' : ''}" title="${esc(label)}">
      ${badgeSvg(name, earned.has(t.id), 44)}
      <span>${esc(name)}</span>
    </li>`;
  return `
    <section class="card badge-case">
      <h3 class="sec">Badge case <b>${count}/8</b>${elite && earned.has(elite.id) ? ' · Elite Four defeated' : ''}</h3>
      <ul>
        ${gyms.map((t) => slot(t, t.badge!, `${t.badge} Badge: beat ${t.leader} (${t.name})`)).join('')}
        ${elite ? slot(elite, 'Elite', `Beat ${elite.leader} (${elite.name})`) : ''}
      </ul>
      <p class="note">Beat a gym team this season to earn its badge. Badges reset each season.</p>
    </section>`;
}

function standingsHtml(f: Franchise): string {
  const rows = standings(f).map((t, i) => `
    <tr class="${t.human ? 'me' : ''} ${i === 3 ? 'cut' : ''}" style="--tc:${t.color}">
      <td>${i + 1}</td>
      <th><div><i></i><span>${esc(t.name)}${t.leader ? `<small>${esc(t.leader)}</small>` : ''}</span></div></th>
      <td>${t.w}</td><td>${t.l}</td>
      <td>${t.pf - t.pa > 0 ? '+' : ''}${t.pf - t.pa}</td>
      <td>${t.streak ? (t.streak > 0 ? `W${t.streak}` : `L${-t.streak}`) : '–'}</td>
    </tr>`).join('');
  return `
    <section class="card">
      <h3 class="sec">Standings</h3>
      <table class="tbl standings">
        <thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th><th>Diff</th><th>Strk</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="note">Top four make the playoffs: 1 vs 4 and 2 vs 3, then the final.</p>
    </section>`;
}

function rosterHtml(f: Franchise): string {
  const me = f.teams[0];
  const open = canSign(f);
  const rows = byPos(f, me.roster).map((u) => {
    const p = f.players[u];
    const m = monOf(f, u);
    const pg = perGame(p.stats);
    return `
      <tr>
        <th><div><img src="${spriteUrl(m.dex)}" alt=""><span>${esc(m.name)}<small>${m.pos} · ${m.archetype}</small></span></div></th>
        <td class="lv">Lv ${p.level}<i style="--v:${(p.xp / xpToNext(p.level)) * 100}%"></i></td>
        <td><b class="t-${tier(m.ovr)}">${m.ovr}</b></td>
        <td>${p.stats.gp ? fmt(pg.ppg) : '–'}</td><td class="opt">${p.stats.gp ? fmt(pg.rpg) : '–'}</td><td class="opt">${p.stats.gp ? fmt(pg.apg) : '–'}</td>
        <td>${open ? `<button class="btn small ghost" data-swap="${u}">Swap</button>` : ''}</td>
      </tr>`;
  }).join('');
  return `
    <section class="card">
      <h3 class="sec">${esc(me.name)} roster</h3>
      <div class="tbl-scroll">
        <table class="tbl roster-tbl">
          <thead><tr><th>Pokémon</th><th>Level</th><th>OVR</th><th>PPG</th><th class="opt">RPG</th><th class="opt">APG</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="note">${open ? 'You can swap one player for a free agent this week.' : f.phase === 'done' ? 'Free agency reopens next season.' : "You've used this week's free-agent signing."} Pokémon earn XP every game; some evolve when they level up.</p>
    </section>`;
}

function leadersHtml(f: Franchise): string {
  const rostered = f.teams.flatMap((t) => t.roster.map((u) => ({ u, t })));
  const cat = (label: string, key: 'ppg' | 'rpg' | 'apg') => {
    const top = rostered
      .filter(({ u }) => f.players[u].stats.gp > 0)
      .map(({ u, t }) => ({ u, t, v: perGame(f.players[u].stats)[key] }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 3);
    return `<div class="lead"><h4>${label}</h4><ol>${top.map(({ u, t, v }) =>
      `<li><img src="${spriteUrl(f.players[u].dex)}" alt=""><span>${esc(monOf(f, u).name)} <small style="color:${t.color}">${esc(t.abbr)}</small></span><b>${fmt(v)}</b></li>`).join('') || '<li class="empty">No games yet</li>'}</ol></div>`;
  };
  return `<section class="card"><h3 class="sec">League leaders</h3><div class="leads">${cat('Points', 'ppg')}${cat('Rebounds', 'rpg')}${cat('Assists', 'apg')}</div></section>`;
}

function scoresHtml(f: Franchise): string {
  const last = [...f.games].filter((g) => g.score).sort((a, b) => b.week - a.week);
  const wk = last[0]?.week;
  const games = last.filter((g) => g.week === wk);
  const line = (g: FGame) => {
    const [h, a] = [f.teams[g.home], f.teams[g.away]];
    const [hs, as] = g.score!;
    const w = (home: boolean) => ((home ? hs > as : as > hs) ? 'win' : '');
    return `<li><span class="${w(true)}">${esc(h.abbr)}</span><b class="${w(true)}">${hs}</b><span>–</span><b class="${w(false)}">${as}</b><span class="${w(false)}">${esc(a.abbr)}</span><small>${g.pog ? `POG ${esc(monOf(f, g.pog).name)}` : ''}</small></li>`;
  };
  return `
    <section class="card">
      <h3 class="sec">${wk ? `${weekLabel(f, wk)} scores` : 'Scores'}</h3>
      <ul class="scores">${games.map(line).join('') || '<li class="empty">No games played yet</li>'}</ul>
      <h3 class="sec">League news</h3>
      <ul class="news">${f.news.map((n) => `<li>${esc(n)}</li>`).join('') || '<li class="empty">Quiet so far.</li>'}</ul>
    </section>`;
}

function freeAgentSheet(f: Franchise, release: string): string {
  const out = monOf(f, release);
  const fas = [...f.freeAgents].sort((a, b) => monOf(f, b).ovr - monOf(f, a).ovr);
  return `
    <div class="sheet-bg">
      <div class="sheet" role="dialog" aria-label="Free agents">
        <button class="close" data-a="close-fa" aria-label="Close">×</button>
        <h3>Swap out ${esc(out.name)} (${out.pos}, ${out.ovr})</h3>
        <p class="note">Pick a free agent to sign. ${esc(out.name)} goes to free agency.</p>
        <ul class="fa-list">${fas.map((u) => {
          const m = monOf(f, u);
          return `<li><img src="${spriteUrl(m.dex)}" alt=""><span class="nm">${esc(m.name)}<small>${m.pos} · ${m.archetype} · Lv ${f.players[u].level}</small><span class="types">${typeChips(m)}</span></span><b class="t-${tier(m.ovr)}">${m.ovr}</b><button class="btn small primary" data-sign="${u}">Sign</button></li>`;
        }).join('')}</ul>
      </div>
    </div>`;
}

export function hubScreen(root: HTMLElement, f: Franchise, settings: Settings, act: HubActions) {
  const host = root;
  root = document.createElement('div');
  host.replaceChildren(root);
  let swapping: string | null = null;

  const render = () => {
    const me = f.teams[0];
    const place = standings(f).indexOf(me) + 1;
    root.innerHTML = `
      <div class="hub">
        <header class="hub-head" style="--tc:${me.color}">
          <button class="btn ghost small" data-a="menu">Menu</button>
          <div>
            <h1>${esc(me.name)}</h1>
            <p>Season ${f.season} · ${f.phase === 'done' ? 'Offseason' : weekLabel(f)} · ${rec(me)}, ${ordinal(place)} place</p>
          </div>
        </header>
        ${nextCard(f, settings)}
        ${badgeCaseHtml(f)}
        <div class="hub-grid">
          <div class="col">${rosterHtml(f)}${scoresHtml(f)}</div>
          <div class="col">${standingsHtml(f)}${leadersHtml(f)}</div>
        </div>
        ${swapping ? freeAgentSheet(f, swapping) : ''}
      </div>`;
    if (root.querySelector('#difficulty')) bindSettings(root, settings, act.saved);
  };

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const swap = t.closest<HTMLElement>('[data-swap]')?.dataset.swap;
    if (swap) { swapping = swap; render(); return; }
    const add = t.closest<HTMLElement>('[data-sign]')?.dataset.sign;
    if (add && swapping) {
      sign(f, swapping, add);
      swapping = null;
      act.saved();
      render();
      return;
    }
    if (t.classList.contains('sheet-bg')) { swapping = null; render(); return; }
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    const g = userGame(f);
    if (a === 'close-fa') { swapping = null; render(); }
    else if (a === 'menu') act.menu();
    else if (a === 'play' && g) act.play(g);
    else if (a === 'sim-mine' && g) act.simMine(g);
    else if (a === 'sim-week') act.simWeek();
    else if (a === 'next-season') act.nextSeason();
  });

  render();
}
