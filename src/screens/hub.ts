import { POSITIONS, monByDex, spriteUrl, type Pos } from '../data/pokemon';
import {
  badgesEarned, canSign, canTrade, finalWeek, judgeTrade, lineupOf, makeTrade, resetLineup, swapInLineup, tradeDeadline, venueOf, monOf, perGame, sign, standings, teamOvrOf, userGame, weekGames, weekLabel,
  xpToNext, type FGame, type FTeam, type Franchise,
} from '../franchise/league';
import { badgeSvg } from '../ui/badges';
import { staminaOf } from '../game/game';
import { esc, tier } from '../util';
import { bindSettings, settingsHtml, type Settings } from './menu';
import { countAt, posTrackHtml, targetPer, typeChips } from './draft';

export interface HubActions {
  play(g: FGame): void;
  simMine(g: FGame): void;
  simWeek(): void;
  /** Start or resume the offseason rookie draft. */
  rookies(): void;
  /** Every game this season, with box scores. */
  games(): void;
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

/** A team's starting five, PG to C. */
function lineup(f: Franchise, t: FTeam): string {
  return `<ul class="lineup">${byPos(f, lineupOf(f, t).starters).map((u) => {
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
        ${f.awards?.length ? `<ul class="awards">${f.awards.map((a) => {
          const t = f.teams[a.team];
          return `<li class="mvp ${t.human ? 'mine' : ''}"><img src="${spriteUrl(f.players[a.uid].dex)}" alt=""><div><span class="lbl">${esc(a.label)}</span><strong>${esc(monOf(f, a.uid).name)}</strong><span>${esc(t.name)} · ${esc(a.line)}</span></div></li>`;
        }).join('')}</ul>`
        : mvp && pg ? `<div class="mvp"><img src="${spriteUrl(mvp.dex)}" alt=""><div><span class="lbl">Season MVP</span><strong>${esc(monByDex(mvp.dex).name)}</strong><span>${esc(mvpTeam?.name ?? '')} · ${fmt(pg.ppg)} PPG · ${fmt(pg.rpg)} RPG · ${fmt(pg.apg)} APG</span></div></div>` : ''}
        <p class="note">Your roster, levels and evolutions carry over. Records and stats reset. First comes the rookie draft: one pick each from the young Pokémon in free agency, worst record first, champion last. Then every team cuts back to ten.${canTrade(f) ? ' Trades are open until the new season starts.' : ''}</p>
        <div class="actions"><button class="btn primary big" data-a="rookies">${f.rookies ? 'Continue rookie draft' : `Rookie draft · Season ${f.season + 1}`}</button></div>
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
      ${settingsHtml(settings, { subs: f.teams[0].roster.length > 5 })}
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

/** `editing`: rows become tappable to rearrange the depth chart; `picked` is the first tap. */
function rosterHtml(f: Franchise, editing: boolean, picked: string | null): string {
  const me = f.teams[0];
  const signable = canSign(f);
  const open = signable && !editing;
  const { starters, bench, out } = lineupOf(f, me);
  const ordinalOf = (i: number) => ['6th', '7th', '8th', '9th', '10th'][i] ?? `${i + 6}th`;
  const row = (u: string) => {
    const p = f.players[u];
    const m = monOf(f, u);
    const pg = perGame(p.stats);
    const mpg = p.stats.gp ? `${((p.stats.sec ?? 0) / 60 / p.stats.gp).toFixed(1)}` : '–';
    const bi = bench.indexOf(u);
    const inj = p.injury ?? 0;
    const tag = inj > 0 ? `<b class="out">OUT ${inj} WK</b> · ` : bi >= 0 ? `${ordinalOf(bi)} · ` : '';
    return `
      <tr class="${editing ? 'pickable' : ''} ${picked === u ? 'picked' : ''}" ${editing ? `data-lu="${u}" tabindex="0"` : ''}>
        <th><div><img src="${spriteUrl(m.dex)}" alt=""><span>${esc(m.name)}<small>${tag}${m.pos} · ${m.archetype}</small></span></div></th>
        <td class="lv">Lv ${p.level}<i style="--v:${(p.xp / xpToNext(p.level)) * 100}%"></i></td>
        <td><b class="t-${tier(m.ovr)}">${m.ovr}</b></td>
        ${bench.length ? `<td class="opt">${staminaOf(m)}</td><td>${mpg}</td>` : ''}
        <td>${p.stats.gp ? fmt(pg.ppg) : '–'}</td><td class="opt">${p.stats.gp ? fmt(pg.rpg) : '–'}</td><td class="opt">${p.stats.gp ? fmt(pg.apg) : '–'}</td>
        <td>${open ? `<button class="btn small ghost" data-swap="${u}">Swap</button>` : ''}</td>
      </tr>`;
  };
  const cols = bench.length ? 10 : 8;
  const covered = new Set(starters.map((u) => monOf(f, u).pos));
  const missing = POSITIONS.filter((p) => !covered.has(p));
  const rows = bench.length
    ? `<tr class="grp"><th colspan="${cols}">Starters</th></tr>${byPos(f, starters).map(row).join('')}<tr class="grp"><th colspan="${cols}">Bench</th></tr>${bench.map(row).join('')}${out.length ? `<tr class="grp"><th colspan="${cols}">Injured</th></tr>${out.map(row).join('')}` : ''}`
    : byPos(f, starters).map(row).join('');
  return `
    <section class="card">
      <div class="roster-head">
        <h3 class="sec">${esc(me.name)} roster${bench.length ? ` <small>${me.lineup ? 'Your lineup' : "Coach's lineup"}</small>` : ''}</h3>
        ${bench.length ? `<div class="head-actions">
          ${canTrade(f) && !editing ? '<button class="btn small" data-a="trade">Trade</button>' : ''}
          ${editing ? '<button class="btn small primary" data-a="lineup-done">Done</button>' : '<button class="btn small" data-a="lineup-edit">Edit lineup</button>'}
          ${me.lineup ? '<button class="btn small ghost" data-a="lineup-auto">Auto lineup</button>' : ''}
        </div>` : ''}
      </div>
      ${editing ? `<p class="note lineup-help">${picked ? `Now tap who trades places with ${esc(monOf(f, picked).name)}.` : 'Tap two players to trade places: a starter and a bench player to change the starting five, or two bench players to change the order the coach uses them.'}</p>` : ''}
      ${bench.length ? depthHtml(f, [...starters, ...bench]) : ''}
      ${bench.length && missing.length ? `<p class="note warn-note">No ${missing.join(' or ')} in your starting five, so no +2 lineup bonus.</p>` : ''}
      <div class="tbl-scroll">
        <table class="tbl roster-tbl">
          <thead><tr><th>Pokémon</th><th>Level</th><th>OVR</th>${bench.length ? '<th class="opt" title="Stamina">STA</th><th>MPG</th>' : ''}<th>PPG</th><th class="opt">RPG</th><th class="opt">APG</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="note">${signable ? 'You can swap one player for a free agent this week.' : f.phase === 'done' ? 'Free agency reopens next season.' : "You've used this week's free-agent signing."} ${f.phase === 'season' ? (canTrade(f) ? `Trade deadline: after week ${tradeDeadline(f)}. ` : 'The trade deadline has passed. ') : ''}${bench.length ? (me.lineup ? 'Your lineup is set. ' : 'The coach starts the best five that cover every position. ') + 'With Subs on Auto, tired players come out at dead balls, 6th man first. ' : ''}Pokémon earn XP every game, more with more minutes; some evolve when they level up.</p>
    </section>`;
}

/** Position depth of the healthy roster: a starter and a backup at every spot is the goal. */
function depthHtml(f: Franchise, healthy: string[]): string {
  const mons = healthy.map((u) => monOf(f, u));
  const need = POSITIONS.filter((p) => countAt(mons, p) === 0);
  const thin = POSITIONS.filter((p) => countAt(mons, p) === 1);
  const fix = canSign(f) ? 'a free agent' : canTrade(f) ? 'a trade' : 'free agency next season';
  const text = need.length
    ? `No healthy ${need.join(' or ')}: someone plays out of position. Look for one in ${fix}.`
    : thin.length
      ? `No backup at ${thin.join(', ')}: when that starter tires, the coach plays someone out of position.${f.phase === 'done' ? '' : ` Try ${fix}.`}`
      : 'A starter and a backup at every position.';
  return `<div class="depth"><span class="depth-lbl">Depth</span>${posTrackHtml(mons, 10)}<p class="pos-note">${text}</p></div>`;
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
      <div class="actions"><button class="btn small" data-a="games">All games &amp; box scores</button></div>
      <h3 class="sec">League news</h3>
      <ul class="news">${f.news.map((n) => `<li>${esc(n)}</li>`).join('') || '<li class="empty">Quiet so far.</li>'}</ul>
    </section>`;
}

interface TradeDraft { team: number; give: string[]; get: string[] }

function tradeSheet(f: Franchise, tr: TradeDraft): string {
  const them = f.teams[tr.team];
  const verdict = judgeTrade(f, tr.team, tr.give, tr.get);
  const row = (u: string, side: 'give' | 'get') => {
    const m = monOf(f, u);
    const p = f.players[u];
    const on = (side === 'give' ? tr.give : tr.get).includes(u);
    const inj = p.injury ?? 0;
    return `<li><button class="trade-row ${on ? 'on' : ''}" data-${side}="${u}">
      <img src="${spriteUrl(m.dex)}" alt="">
      <span class="nm">${esc(m.name)}<small>${m.pos} · Lv ${p.level}${inj ? ` · <b class="out">OUT ${inj} WK</b>` : ''}</small></span>
      <b class="t-${tier(m.ovr)}">${m.ovr}</b>
    </button></li>`;
  };
  const sortByOvr = (us: string[]) => [...us].sort((a, b) => monOf(f, b).ovr - monOf(f, a).ovr);
  const pct = Math.round((verdict.lean + 1) * 50);
  return `
    <div class="sheet-bg">
      <div class="sheet trade-sheet" role="dialog" aria-label="Trade">
        <button class="close" data-a="close-trade" aria-label="Close">×</button>
        <h3>Trade</h3>
        <div class="trade-teams">${f.teams.filter((t) => !t.human).map((t) =>
          `<button class="${t.id === tr.team ? 'on' : ''}" data-tteam="${t.id}" style="--tc:${t.color}" title="${esc(t.name)}">${esc(t.abbr)}</button>`).join('')}</div>
        <p class="note">${esc(them.name)}${them.leader ? ` (${esc(them.leader)})` : ''}${them.types?.length ? ` likes ${them.types.join('/')} types` : ''}. Pick the same number of players on each side, up to two.</p>
        <div class="trade-cols">
          <div><h4>You give</h4><ul>${sortByOvr(f.teams[0].roster).map((u) => row(u, 'give')).join('')}</ul></div>
          <div><h4>You get</h4><ul>${sortByOvr(them.roster).map((u) => row(u, 'get')).join('')}</ul></div>
        </div>
        <div class="verdict ${verdict.ok ? 'ok' : ''}">
          <div class="meter"><i style="--v:${pct}%"></i></div>
          <p>${esc(tr.give.length || tr.get.length ? verdict.reason : 'Build an offer to see what they think.')}</p>
        </div>
        <div class="actions"><button class="btn primary" data-a="propose" ${verdict.ok ? '' : 'disabled'}>Propose trade</button></div>
      </div>
    </div>`;
}

function freeAgentSheet(f: Franchise, release: string, pos: Pos | 'ALL'): string {
  const out = monOf(f, release);
  // Positions the roster would be short at after letting this player go.
  const after = f.teams[0].roster.filter((u) => u !== release).map((u) => monOf(f, u));
  const goal = targetPer(f.teams[0].roster.length);
  const wants = new Set(POSITIONS.filter((p) => countAt(after, p) < goal));
  const fas = [...f.freeAgents].filter((u) => pos === 'ALL' || monOf(f, u).pos === pos).sort((a, b) => monOf(f, b).ovr - monOf(f, a).ovr);
  return `
    <div class="sheet-bg">
      <div class="sheet" role="dialog" aria-label="Free agents">
        <button class="close" data-a="close-fa" aria-label="Close">×</button>
        <h3>Swap out ${esc(out.name)} (${out.pos}, ${out.ovr})</h3>
        <p class="note">Pick a free agent to sign. ${esc(out.name)} goes to free agency.${wants.size ? ` You'd be short at <b>${[...wants].join(', ')}</b>.` : ''}</p>
        <div class="filters">${(['ALL', ...POSITIONS] as const).map((p) => `<button data-fapos="${p}" class="${p === pos ? 'on' : ''} ${p !== 'ALL' && wants.has(p) ? 'need' : ''}">${p}</button>`).join('')}</div>
        <ul class="fa-list">${fas.map((u) => {
          const m = monOf(f, u);
          return `<li><img src="${spriteUrl(m.dex)}" alt=""><span class="nm">${esc(m.name)}<small>${m.pos} · ${m.archetype} · Lv ${f.players[u].level}${wants.has(m.pos) ? ' · <b class="fits">Fills a need</b>' : ''}</small><span class="types">${typeChips(m)}</span></span><b class="t-${tier(m.ovr)}">${m.ovr}</b><button class="btn small primary" data-sign="${u}">Sign</button></li>`;
        }).join('')}</ul>
      </div>
    </div>`;
}

export function hubScreen(root: HTMLElement, f: Franchise, settings: Settings, act: HubActions) {
  const host = root;
  root = document.createElement('div');
  host.replaceChildren(root);
  let swapping: string | null = null;
  let faPos: Pos | 'ALL' = 'ALL';
  let trading: TradeDraft | null = null;
  let editing = false;
  let picked: string | null = null;

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
          <div class="col">${rosterHtml(f, editing, picked)}${scoresHtml(f)}</div>
          <div class="col">${standingsHtml(f)}${leadersHtml(f)}</div>
        </div>
        ${swapping ? freeAgentSheet(f, swapping, faPos) : ''}
        ${trading ? tradeSheet(f, trading) : ''}
      </div>`;
    if (root.querySelector('#difficulty')) bindSettings(root, settings, act.saved);
  };

  // Lineup rows are keyboard-selectable too.
  root.addEventListener('keydown', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-lu]');
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      row.click();
    }
  });
  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const swap = t.closest<HTMLElement>('[data-swap]')?.dataset.swap;
    if (swap) { swapping = swap; faPos = 'ALL'; render(); return; }
    const fp = t.closest<HTMLElement>('[data-fapos]')?.dataset.fapos;
    if (fp) { faPos = fp as Pos | 'ALL'; render(); return; }
    const lu = t.closest<HTMLElement>('[data-lu]')?.dataset.lu;
    if (lu && editing) {
      if (!picked || picked === lu) picked = picked === lu ? null : lu;
      else {
        swapInLineup(f, picked, lu);
        picked = null;
        act.saved();
      }
      render();
      return;
    }
    const add = t.closest<HTMLElement>('[data-sign]')?.dataset.sign;
    if (add && swapping) {
      sign(f, swapping, add);
      swapping = null;
      act.saved();
      render();
      return;
    }
    if (t.classList.contains('sheet-bg')) { swapping = null; trading = null; render(); return; }
    if (trading) {
      const tr = trading;
      const toggle = (list: string[], u: string) => (list.includes(u) ? list.filter((x) => x !== u) : [...list, u].slice(-2));
      const give = t.closest<HTMLElement>('[data-give]')?.dataset.give;
      const get = t.closest<HTMLElement>('[data-get]')?.dataset.get;
      const team = t.closest<HTMLElement>('[data-tteam]')?.dataset.tteam;
      if (give) tr.give = toggle(tr.give, give);
      else if (get) tr.get = toggle(tr.get, get);
      else if (team) trading = { team: Number(team), give: tr.give, get: [] };
      else if (t.closest('[data-a="close-trade"]')) trading = null;
      else if (t.closest('[data-a="propose"]') && makeTrade(f, tr.team, tr.give, tr.get)) {
        trading = null;
        act.saved();
      }
      if (give || get || team || !trading) { render(); return; }
    }
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    const g = userGame(f);
    if (a === 'trade') { trading = { team: 1, give: [], get: [] }; render(); return; }
    if (a === 'lineup-edit') { editing = true; picked = null; render(); return; }
    if (a === 'lineup-done') { editing = false; picked = null; render(); return; }
    if (a === 'lineup-auto') { resetLineup(f); editing = false; picked = null; act.saved(); render(); return; }
    if (a === 'close-fa') { swapping = null; render(); }
    else if (a === 'menu') act.menu();
    else if (a === 'play' && g) act.play(g);
    else if (a === 'sim-mine' && g) act.simMine(g);
    else if (a === 'sim-week') act.simWeek();
    else if (a === 'rookies') act.rookies();
    else if (a === 'games') act.games();
  });

  render();
}
