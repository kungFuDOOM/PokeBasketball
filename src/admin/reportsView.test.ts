import { describe, expect, it } from 'vitest';
import { bansHtml, personLabel, reportsHtml, type Check, type Reported } from './reportsView';

const check = (over: Partial<Check> = {}): Check => ({
  match_id: 'm1', queue: 'ranked', has_evidence: true, status: null, agrees: null, cheater_is_reported: null, ...over,
});

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
    expect(html.match(/data-user="aaaaaaaa-1"[^>]*data-role="reported"/g)).toHaveLength(5); // the 4 ban/name buttons + Dismiss
  });

  it('gives the reported player exactly one Dismiss button, carrying the report count', () => {
    const html = reportsHtml([row({ reports: 3 })]);
    const dismiss = html.match(/<button[^>]*data-act="dismiss"[^>]*>/g);
    expect(dismiss).toHaveLength(1);
    expect(dismiss![0]).toContain('data-user="aaaaaaaa-1"');
    expect(dismiss![0]).toContain('data-role="reported"');
    expect(dismiss![0]).toContain('data-reports="3"');
  });

  it('leaves the reporter buttons unchanged: no Dismiss among them', () => {
    const html = reportsHtml([row()]);
    const reporter = html.match(/<button[^>]*data-user="bbbbbbbb-2"[^>]*>/g)!;
    expect(reporter.map((b) => b.match(/data-act="([^"]+)"/)![1])).toEqual(['24', '168', '0', 'name']);
  });

  it('keeps Dismiss on a suspended reported player, but not on the Suspended tab', () => {
    expect(reportsHtml([row({ banned_until: '2026-11-30T00:00:00Z' })]).match(/data-act="dismiss"/g)).toHaveLength(1);
    expect(bansHtml([{ user_id: 'x', name: 'X', until: '2026-11-30T00:00:00Z', reason: null, auto: false, since: '2026-10-30T00:00:00Z' }])).not.toContain('dismiss');
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

  it('renders each cheat-check tag with a reason as its title', () => {
    const tagOf = (checks: Check[]) => reportsHtml([row({ checks })]).match(/<span class="(tag[^"]*)" title="([^"]+)">(Clean|Flagged|No check)<\/span>/)!;
    const clean = tagOf([check({ status: 'final', agrees: true })]);
    expect([clean[1], clean[3]]).toEqual(['tag ok', 'Clean']);
    const flagged = tagOf([check({ status: 'forfeit', cheater_is_reported: true, notes: 'signed two versions of frame 812' })]);
    expect([flagged[1], flagged[2], flagged[3]]).toEqual(['tag bad', 'forfeit: signed two versions of frame 812', 'Flagged']);
    const none = tagOf([check({ queue: 'social', has_evidence: false })]);
    expect([none[1], none[3]]).toEqual(['tag', 'No check']);
  });

  it('renders "No check" for rows without checks (a server before migration 20261123)', () => {
    const html = reportsHtml([row()]);
    expect(html).toContain('<th>Cheat check</th>');
    expect(html).toMatch(/<span class="tag" title="[^"]+">No check<\/span>/);
  });

  it('shows the report count prominently beside the reporter count', () => {
    const html = reportsHtml([row({ reports: 3, reporters: 2 })]);
    expect(html).toContain('<strong>3 reports</strong><small>2 reporters</small>');
  });

  it('puts flagged rows first, then repeat-reported ones', () => {
    const html = reportsHtml([
      row({ user_id: 'one-report', reports: 1, last_at: '2026-10-31T00:00:00Z' }),
      row({ user_id: 'repeat', reports: 2 }),
      row({ user_id: 'flagged', reports: 1, checks: [check({ status: 'invalid' })] }),
    ]);
    const order = [...html.matchAll(/data-act="dismiss" data-user="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['flagged', 'repeat', 'one-report']);
  });

  it('confirm text names which person it is about', () => {
    expect(personLabel('Kissass', 'reporter')).toBe('Kissass (the reporter)');
    expect(personLabel('Fvcker', 'reported')).toBe('Fvcker (the reported player)');
  });
});
