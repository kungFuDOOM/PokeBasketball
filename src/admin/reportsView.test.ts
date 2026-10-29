import { describe, expect, it } from 'vitest';
import { personLabel, reportsHtml, type Reported } from './reportsView';

const row = (over: Partial<Reported> = {}): Reported => ({
  user_id: 'aaaaaaaa-1', name: 'Fvcker', reporters: 1, reports: 1, reasons: { name: 1 }, last_at: '2026-10-30T00:00:00Z', banned_until: null,
  latest: [{ reason: 'name', note: null, at: '2026-10-30T00:00:00Z', from: 'Kissass', from_id: 'bbbbbbbb-2' }], ...over,
});

describe('admin Reported tab', () => {
  it('labels the player column as the reported player and each entry as "Reported by"', () => {
    const html = reportsHtml([row()]);
    expect(html).toContain('<th>Reported player</th>');
    expect(html).toContain('Reported by <b>Kissass</b>');
  });

  it('gives each reporter its own buttons, aimed at the reporter id, apart from the reported player\'s', () => {
    const html = reportsHtml([row()]);
    expect(html.match(/data-user="bbbbbbbb-2"[^>]*data-role="reporter"/g)).toHaveLength(4);
    expect(html.match(/data-user="aaaaaaaa-1"[^>]*data-role="reported"/g)).toHaveLength(4);
  });

  it('hides the reporter buttons when the server has no from_id yet', () => {
    const html = reportsHtml([row({ latest: [{ reason: 'name', note: null, at: '2026-10-30T00:00:00Z', from: 'Kissass' }] })]);
    expect(html).toContain('Reported by <b>Kissass</b>');
    expect(html).not.toContain('data-role="reporter"');
  });

  it('flags vulgar names of the reported player and of reporters, not clean ones', () => {
    const html = reportsHtml([row()]);
    expect(html.match(/bad name/g)).toHaveLength(2);
    expect(reportsHtml([row({ name: 'Titans', latest: [{ reason: 'other', note: null, at: '2026-10-30T00:00:00Z', from: 'Classic', from_id: 'c' }] })])).not.toContain('bad name');
  });

  it('confirm text names which person it is about', () => {
    expect(personLabel('Kissass', 'reporter')).toBe('Kissass (the reporter)');
    expect(personLabel('Fvcker', 'reported')).toBe('Fvcker (the reported player)');
  });
});
