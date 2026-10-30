import { describe, expect, it, vi } from 'vitest';
import { RankedUpdatingError, applyPickState, countdownText, initialPickModel, pickedMatch, presetPickHtml, selectPreset } from './presetPick';
import { OnlineError } from '../shared/onlineMatchService';
import { RANKED_PRESETS, presetRoster } from './presets';

// spriteUrl() looks on window for inlined sprites; the tests run in node.
vi.stubGlobal('window', {});

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe('presetPickHtml', () => {
  const idle = presetPickHtml(initialPickModel(20));

  it('shows six cards with five sprites each and the 425 total', () => {
    expect(count(idle, /class="pp-card/g)).toBe(6);
    for (const card of idle.split('class="pp-card').slice(1)) {
      expect(count(card, /<img src="[^"]*"/g)).toBe(5);
      expect(card).toContain('>425<');
    }
    for (const p of RANKED_PRESETS) for (const mon of presetRoster(p.id)) expect(idle).toContain(mon.name);
    expect(idle).toContain('0:20');
  });

  it('never disables a card (mirror picks are allowed)', () => {
    const locked = presetPickHtml({ ...initialPickModel(), selected: 'B', locked: 'B' });
    for (const html of [idle, locked]) expect(html).not.toMatch(/class="pp-card[^>]*disabled/);
  });

  it('enables Lock in only after a tap, then shows Waiting once locked', () => {
    expect(idle).toMatch(/data-a="lock" disabled/);
    const sel = selectPreset(initialPickModel(), 'C');
    expect(presetPickHtml(sel)).toContain('Lock in team C');
    const locked = presetPickHtml({ ...sel, locked: 'C' });
    expect(locked).toContain('Waiting for opponent');
    expect(locked).not.toContain('data-a="lock"');
    expect(selectPreset({ ...sel, locked: 'C' }, 'A').locked).toBe('C');
  });

  it('never shows anything about the opponent', () => {
    for (const html of [idle, presetPickHtml({ ...initialPickModel(), selected: 'D', locked: 'D' })]) {
      expect(html).not.toMatch(/opponent'?s|opp-|their team|picked by/i);
      expect(count(html, /class="pp-card on"/g)).toBeLessThanOrEqual(1);
    }
  });

  it('takes the server pick (auto on timeout) and the countdown from the pick state', () => {
    const m = applyPickState(initialPickModel(), { mine: 'F', deadline_s: 3.2, done: false });
    expect(m).toMatchObject({ locked: 'F', selected: 'F', secondsLeft: 4 });
    expect(countdownText(4)).toBe('0:04');
    expect(countdownText(-2)).toBe('0:00');
  });
});

describe('pickedMatch', () => {
  const root = {} as HTMLElement;
  const rosters = [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]];
  const svc = (info: { game: { rosters?: unknown } }) => ({ rankedPick: vi.fn(), rankedPickState: vi.fn(), matchInfo: vi.fn(async () => info) });

  it('picks, then reads the match again with both preset rosters', async () => {
    const s = svc({ game: { rosters } });
    const pick = vi.fn(async () => {});
    await expect(pickedMatch(root, s, 'm1', undefined, pick)).resolves.toEqual({ game: { rosters } });
    expect(pick).toHaveBeenCalledWith(root, s, 'm1', undefined);
    expect(s.matchInfo).toHaveBeenCalledWith('m1');
  });

  it('a server without the pick RPCs (PGRST202) is "Ranked is updating", never random teams', async () => {
    const s = svc({ game: { rosters } });
    const pick = vi.fn(async () => { throw new OnlineError('Could not find the function', 'PGRST202', 404); });
    await expect(pickedMatch(root, s, 'm1', undefined, pick)).rejects.toBeInstanceOf(RankedUpdatingError);
    expect(s.matchInfo).not.toHaveBeenCalled();
  });

  it('no rosters after the pick is an error', async () => {
    await expect(pickedMatch(root, svc({ game: {} }), 'm1', undefined, async () => {})).rejects.toThrow('no preset rosters');
  });
});
