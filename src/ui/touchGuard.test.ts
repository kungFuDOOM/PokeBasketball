import { describe, expect, it } from 'vitest';
import { installTouchGuard } from './touchGuard';

function setup() {
  const handlers = new Map<string, (e: Event) => void>();
  const doc = {
    addEventListener: (type: string, fn: (e: Event) => void) => { handlers.set(type, fn); },
    removeEventListener: (type: string) => { handlers.delete(type); },
  };
  const off = installTouchGuard(doc);
  const fire = (type: string, native = false) => {
    let prevented = false;
    const target = { closest: () => (native ? {} : null) };
    handlers.get(type)!({ target, preventDefault: () => { prevented = true; } } as unknown as Event);
    return prevented;
  };
  return { handlers, fire, off };
}

describe('touch guard', () => {
  it('blocks gestures and dblclick', () => {
    const { fire } = setup();
    for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) expect(fire(type)).toBe(true);
  });

  it('never cancels touchend: that would swallow quick taps on buttons', () => {
    const { handlers } = setup();
    expect(handlers.has('touchend')).toBe(false);
  });

  it('leaves inputs and iframes alone', () => {
    const { fire } = setup();
    expect(fire('selectstart', true)).toBe(false);
    expect(fire('contextmenu', true)).toBe(false);
  });

  it('uninstalls', () => {
    const { handlers, off } = setup();
    off();
    expect(handlers.size).toBe(0);
  });
});
