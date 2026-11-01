import { emptyIntent, type Intent } from './types';

type Btn = 'shoot' | 'pass' | 'steal' | 'turbo' | 'special' | 'pause';

const KEYMAP: Record<string, Btn> = {
  KeyJ: 'shoot', Space: 'shoot',
  KeyK: 'pass',
  KeyL: 'steal',
  ShiftLeft: 'turbo', ShiftRight: 'turbo',
  KeyI: 'special', KeyE: 'special',
  KeyP: 'pause', Escape: 'pause',
};
const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', ...Object.keys(KEYMAP)]);

export class Input {
  private keys = new Set<string>();
  private touchBtn: Record<Btn, boolean> = { shoot: false, pass: false, steal: false, turbo: false, special: false, pause: false };
  private touchMove = { x: 0, y: 0 };
  private prev: Record<Btn, boolean> = { shoot: false, pass: false, steal: false, turbo: false, special: false, pause: false };
  private touchRoot: HTMLElement | null = null;
  private labels: Partial<Record<Btn, HTMLElement>> = {};
  enabled = true;

  constructor() {
    window.addEventListener('keydown', this.onKey, { passive: false });
    window.addEventListener('keyup', this.onKey, { passive: false });
    window.addEventListener('blur', () => this.keys.clear());
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    this.touchRoot?.remove();
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.type === 'keydown') this.keys.add(e.code);
    else this.keys.delete(e.code);
  };

  private held(): Record<Btn, boolean> & { mx: number; my: number } {
    const k = this.keys;
    const h: Record<Btn, boolean> = { ...this.touchBtn };
    for (const [code, btn] of Object.entries(KEYMAP)) if (k.has(code)) h[btn] = true;
    let mx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let my = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    mx += this.touchMove.x;
    my += this.touchMove.y;

    const pads = navigator.getGamepads?.() ?? [];
    for (const gp of pads) {
      if (!gp) continue;
      const ax = gp.axes[0] ?? 0;
      const ay = gp.axes[1] ?? 0;
      if (Math.hypot(ax, ay) > 0.25) { mx += ax; my += ay; }
      const b = (i: number) => !!gp.buttons[i]?.pressed;
      if (b(12)) my -= 1;
      if (b(13)) my += 1;
      if (b(14)) mx -= 1;
      if (b(15)) mx += 1;
      // 2K layout: A passes, X shoots.
      if (b(0)) h.pass = true;
      if (b(2)) h.shoot = true;
      if (b(1)) h.steal = true;
      if (b(3)) h.special = true;
      if (b(4) || b(5) || b(6) || b(7)) h.turbo = true;
      if (b(9)) h.pause = true;
    }
    const m = Math.hypot(mx, my);
    if (m > 1) { mx /= m; my /= m; }
    return { ...h, mx, my };
  }

  /** Reads the user's intent for this frame; `pause` is reported separately via the return flag. */
  read(): { intent: Intent; pause: boolean } {
    const h = this.held();
    const pressed = (b: Btn) => h[b] && !this.prev[b];
    const it = emptyIntent();
    it.mx = h.mx;
    it.my = h.my;
    it.turbo = h.turbo;
    it.shoot = pressed('shoot');
    it.shootHeld = h.shoot;
    it.pass = pressed('pass');
    it.swap = it.pass;
    it.steal = pressed('steal');
    it.special = pressed('special');
    const pause = pressed('pause');
    for (const b of Object.keys(this.prev) as Btn[]) this.prev[b] = h[b];
    return { intent: it, pause };
  }

  /** Swaps button captions between offense and defense. */
  setContext(offense: boolean, specialReady: boolean) {
    const l = this.labels;
    if (l.shoot) l.shoot.textContent = offense ? 'SHOOT' : 'JUMP';
    if (l.pass) l.pass.textContent = offense ? 'PASS' : 'SWITCH';
    l.special?.closest('.tb')?.classList.toggle('ready', specialReady);
  }

  /** On-screen joystick and buttons for touch devices. */
  attachTouch(parent: HTMLElement) {
    const root = document.createElement('div');
    root.className = 'touch';
    root.innerHTML = `
      <div class="stick-zone"><div class="stick-base"><div class="stick-knob"></div></div></div>
      <div class="btns">
        <button class="tb turbo" data-b="turbo"><b>RB</b><span>TURBO</span></button>
        <button class="tb special xy" data-b="special"><b>Y</b><span>SPECIAL</span></button>
        <button class="tb shoot xx" data-b="shoot"><b>X</b><span>SHOOT</span></button>
        <button class="tb steal xb" data-b="steal"><b>B</b><span>STEAL</span></button>
        <button class="tb pass xa" data-b="pass"><b>A</b><span>PASS</span></button>
      </div>`;
    parent.appendChild(root);
    this.touchRoot = root;

    root.querySelectorAll<HTMLButtonElement>('.tb').forEach((el) => {
      const b = el.dataset.b as Btn;
      this.labels[b] = el.querySelector('span') ?? el;
      const down = (e: PointerEvent) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this.touchBtn[b] = true;
        el.classList.add('on');
      };
      const up = (e: PointerEvent) => {
        e.preventDefault();
        this.touchBtn[b] = false;
        el.classList.remove('on');
      };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    const zone = root.querySelector<HTMLElement>('.stick-zone')!;
    const base = root.querySelector<HTMLElement>('.stick-base')!;
    const knob = root.querySelector<HTMLElement>('.stick-knob')!;
    let id: number | null = null;
    let cx = 0;
    let cy = 0;
    const R = 46;
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      id = e.pointerId;
      zone.setPointerCapture(id);
      const r = zone.getBoundingClientRect();
      cx = e.clientX;
      cy = e.clientY;
      base.style.left = `${cx - r.left}px`;
      base.style.top = `${cy - r.top}px`;
      base.classList.add('on');
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const m = Math.hypot(dx, dy) / R;
      this.touchMove = m < 0.15 ? { x: 0, y: 0 } : { x: dx / R, y: dy / R };
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = null;
      this.touchMove = { x: 0, y: 0 };
      knob.style.transform = '';
      base.classList.remove('on');
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }
}
