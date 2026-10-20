import { spriteUrl, type PokeType } from '../data/pokemon';
import type { Game } from './game';
import type { GameEvent, Grade, Player } from './types';

const DUNK_MOVES: Record<PokeType, string> = {
  Normal: 'BODY SLAM', Fire: 'FLARE BLITZ', Water: 'WATERFALL', Electric: 'THUNDER PUNCH',
  Grass: 'WOOD HAMMER', Ice: 'ICICLE CRASH', Fighting: 'SKY UPPERCUT', Poison: 'POISON JAB',
  Ground: 'HIGH HORSEPOWER', Flying: 'BRAVE BIRD', Psychic: 'ZEN HEADBUTT', Bug: 'MEGAHORN',
  Rock: 'HEAD SMASH', Ghost: 'SHADOW CLAW', Dragon: 'DRAGON RUSH', Dark: 'CRUNCH',
  Steel: 'METEOR MASH', Fairy: 'PLAY ROUGH',
};

const GRADE_TEXT: Record<Grade, [string, string]> = {
  perfect: ['EXCELLENT', 'green'],
  good: ['GOOD RELEASE', 'white'],
  early: ['SLIGHTLY EARLY', 'yellow'],
  late: ['SLIGHTLY LATE', 'yellow'],
  'very-early': ['VERY EARLY', 'red'],
  'very-late': ['VERY LATE', 'red'],
  layup: ['', 'white'],
  dunk: ['', 'white'],
};

const fmtClock = (s: number) => {
  const t = Math.max(0, s);
  if (t < 10) return t.toFixed(1);
  const m = Math.floor(t / 60);
  return `${m}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
};

const NAME = (p: Player) => p.mon.name.toUpperCase();

export class Hud {
  readonly el: HTMLElement;
  private q: (s: string) => HTMLElement;
  private msgs: string[] = [];
  private msgT = 0;
  private bannerT = 0;
  private gradeT = 0;
  private cardDex = -1;
  private last: Record<string, string> = {};

  constructor(parent: HTMLElement, private g: Game) {
    const [h, a] = g.teams;
    const el = document.createElement('div');
    el.className = 'hud';
    el.innerHTML = `
      <div class="bug">
        <div class="bug-team" style="--tc:${h.color}"><span class="abbr">${h.abbr}</span><span class="pts" data-k="s0">0</span></div>
        <div class="bug-team" style="--tc:${a.color}"><span class="abbr">${a.abbr}</span><span class="pts" data-k="s1">0</span></div>
        <div class="bug-clock"><span data-k="q">1ST</span><span data-k="clock">0:00</span></div>
        <div class="bug-shot" data-k="shot">24</div>
      </div>
      <div class="grade" data-k="grade"></div>
      <div class="banner" data-k="banner"><div class="banner-main"></div><div class="banner-sub"></div></div>
      <div class="pcard" data-k="pcard">
        <img alt="" data-k="pimg">
        <div class="pinfo">
          <div class="pname"><span data-k="pname"></span><span class="povr" data-k="povr"></span></div>
          <div class="bar turbo"><i data-k="turbo"></i><b>TURBO</b></div>
          <div class="bar spec"><i data-k="spec"></i><b data-k="specname">SPECIAL</b></div>
        </div>
      </div>
      <div class="battle" data-k="battle"><p data-k="msg"></p></div>`;
    parent.appendChild(el);
    this.el = el;
    this.q = (k: string) => el.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
    if (!g.isHumanTeam(0)) this.q('pcard').hidden = true;
    else {
      const starter = g.players.find((p) => p.team === 0 && p.slot === 0)!;
      this.say(`Wild ${a.name.toUpperCase()} appeared!`, `Go! ${NAME(starter)} and crew!`, 'Hold SHOOT, release on green.');
    }
  }

  private set(k: string, v: string) {
    if (this.last[k] === v) return;
    this.last[k] = v;
    this.q(k).textContent = v;
  }

  private say(...lines: string[]) {
    for (const l of lines) this.msgs.push(l);
    if (this.msgs.length > 4) this.msgs.splice(0, this.msgs.length - 4);
  }

  private banner(main: string, sub = '', dur = 2) {
    const b = this.q('banner');
    b.querySelector('.banner-main')!.textContent = main;
    b.querySelector('.banner-sub')!.textContent = sub;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    this.bannerT = dur;
  }

  handle(events: GameEvent[]) {
    for (const e of events) {
      switch (e.kind) {
        case 'score': {
          const tag = e.player.team === 0 ? 's0' : 's1';
          const s = this.q(tag);
          s.classList.remove('pop');
          void s.offsetWidth;
          s.classList.add('pop');
          if (e.how === 'dunk') this.say(`${NAME(e.player)} used ${DUNK_MOVES[e.player.mon.types[0]]}!`, `It's super effective!`);
          else if (e.points === 3) this.say(`${NAME(e.player)} drains a three!`);
          break;
        }
        case 'miss':
          if (e.airball) this.say(`AIRBALL! ${NAME(e.player)} hurt itself in its confusion!`);
          break;
        case 'release':
          if (e.player.human) {
            const [txt, col] = GRADE_TEXT[e.grade];
            const g = this.q('grade');
            g.textContent = txt;
            g.dataset.c = col;
            g.classList.remove('show');
            void g.offsetWidth;
            g.classList.add('show');
            this.gradeT = 1.2;
          }
          break;
        case 'block':
          this.say(`${NAME(e.player)} used PROTECT!`, `${NAME(e.victim)}'s shot was rejected!`);
          break;
        case 'steal':
          this.say(`${NAME(e.player)} used THIEF!`, `${NAME(e.player)} stole the ball!`);
          break;
        case 'shove':
          if (e.mult === 0) this.say(`${NAME(e.player)} used TACKLE!`, `It doesn't affect ${NAME(e.victim)}...`);
          else if (!e.ok) this.say(`${NAME(e.player)} used TACKLE!`, `${NAME(e.player)}'s attack missed!`);
          else if (e.mult >= 2) this.say(`${NAME(e.player)} used TACKLE!`, `It's super effective!`);
          else if (e.mult < 1) this.say(`${NAME(e.player)} used TACKLE!`, `It's not very effective...`);
          else this.say(`${NAME(e.player)} used TACKLE!`);
          break;
        case 'special': {
          const lines = [`${NAME(e.player)} used ${e.player.mon.move}!`];
          const immune = e.hits.find((h) => h.mult === 0);
          if (e.hits.some((h) => h.mult >= 2)) lines.push(`It's super effective!`);
          else if (e.hits.length && e.hits.every((h) => h.mult > 0 && h.mult < 1)) lines.push(`It's not very effective...`);
          if (immune) lines.push(`It doesn't affect ${NAME(immune.victim)}...`);
          this.say(...lines);
          break;
        }
        case 'fire':
          if (e.on) this.banner(`${NAME(e.player)}`, 'IS ON FIRE!', 2.2);
          else this.say(`${NAME(e.player)} cooled off.`);
          break;
        case 'oop':
          this.say(`ALLEY-OOP to ${NAME(e.player)}!`);
          break;
        case 'shotclock':
          this.say(`SHOT CLOCK VIOLATION!`);
          break;
        case 'quarter':
          this.banner(e.label, e.sub, 2.2);
          break;
        case 'final':
          this.banner('FINAL', `${this.g.teams[0].abbr} ${this.g.score[0]} - ${this.g.score[1]} ${this.g.teams[1].abbr}`, 3);
          break;
      }
    }
  }

  update(dt: number) {
    const g = this.g;
    this.set('s0', String(g.score[0]));
    this.set('s1', String(g.score[1]));
    const q = g.quarter > 4 ? (g.quarter === 5 ? 'OT' : `${g.quarter - 4}OT`) : ['1ST', '2ND', '3RD', '4TH'][g.quarter - 1];
    this.set('q', q);
    this.set('clock', fmtClock(g.clock));
    this.set('shot', String(Math.max(0, Math.ceil(g.shotClock))));
    this.q('shot').classList.toggle('low', g.shotClock < 5);

    const u = g.user;
    if (u) {
      if (this.cardDex !== u.mon.dex) {
        this.cardDex = u.mon.dex;
        (this.q('pimg') as HTMLImageElement).src = spriteUrl(u.mon.dex);
        this.set('pname', u.mon.name.toUpperCase());
        this.set('povr', `${u.mon.pos} ${u.mon.ovr}`);
        this.set('specname', u.mon.move);
      }
      this.q('turbo').style.width = `${(u.fx.surge > 0 || u.fire ? 1 : u.turbo) * 100}%`;
      this.q('spec').style.width = `${u.special * 100}%`;
      this.q('pcard').classList.toggle('ready', u.special >= 1);
      this.q('pcard').classList.toggle('fire', u.fire);
    }

    this.msgT -= dt;
    if (this.msgT <= 0) {
      const next = this.msgs.shift();
      const box = this.q('battle');
      if (next) {
        this.set('msg', next);
        box.classList.add('show');
        this.msgT = 1.5;
      } else {
        box.classList.remove('show');
        this.msgT = 0;
      }
    }
    this.bannerT -= dt;
    if (this.bannerT <= 0) this.q('banner').classList.remove('show');
    this.gradeT -= dt;
    if (this.gradeT <= 0) this.q('grade').classList.remove('show');
  }
}
