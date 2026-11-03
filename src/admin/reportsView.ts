// The Reported and Suspended tables of the moderation page, as pure HTML builders (so they can be tested without a page).
import { isNameBlocked } from '../nameFilter';
import { esc } from '../util';
import { cheatTag, sortReported, type MatchCheck } from './cheatTag';

export interface ReportEntry { reason: string; note: string | null; at: string; from: string | null; /** The reporter's id: present once migration 20261116 is applied. */ from_id?: string | null }
export interface Reported {
  user_id: string; name: string | null; reporters: number; reports: number; reasons: Record<string, number> | null;
  latest: ReportEntry[] | null; last_at: string; banned_until: string | null;
  /** Quit offences still on the record. Absent on a server without the quit-ban migration. */
  quit_offences?: number | null;
  /** Ranked matchmaking ban, when it is still running. */
  ranked_ban_until?: string | null;
  /** One entry per reported match: present once migration 20261123 is applied. Without it the row shows "No check". */
  checks?: Check[] | null;
}
/** A match check; `notes` (the judge's reason) is used for the tooltip when the server sends it. */
export type Check = MatchCheck & { notes?: string | null };
export interface Ban {
  user_id: string; name: string | null; until: string; reason: string | null; auto: boolean; since: string;
  quit_offences?: number | null; ranked_ban_until?: string | null;
}

/** Offence count and a live Ranked ban, for the player row. Empty when the server did not send them. */
export function rankedQuitHtml(offences: number | null | undefined, until: string | null | undefined): string {
  if (typeof offences !== 'number' && !until) return '';
  const n = typeof offences === 'number' ? offences : 0;
  const live = !!until && new Date(until).getTime() > Date.now();
  return `<small>Ranked quits: ${n}</small>${live ? ` <span class="tag bad">Ranked banned until ${esc(when(until!))}</span>` : ''}`;
}

/** Lifts the Ranked queue ban. Shown only while one is running. */
export function clearRankedBanButton(r: { user_id: string; name: string | null; ranked_ban_until?: string | null }): string {
  if (!r.ranked_ban_until || new Date(r.ranked_ban_until).getTime() <= Date.now()) return '';
  return `<button class="btn small" data-act="clear-ranked" data-user="${esc(r.user_id)}" data-name="${esc(r.name ?? 'Trainer')}" data-role="reported">Clear Ranked ban</button>`;
}

export const when = (iso: string) => new Date(iso).toLocaleString();
export const forever = (iso: string) => new Date(iso).getFullYear() > new Date().getFullYear() + 50;

/** A small red tag next to a name the team-name filter refuses. */
const badName = (name: string | null) => (name && isNameBlocked(name) ? ' <span class="tag bad">bad name</span>' : '');

/** The buttons for one person. `role` shows in the confirm dialog so a moderator sees whether it is the reported player or a reporter. */
export const actions = (r: { user_id: string; name: string | null }, banned: boolean, role: 'reported' | 'reporter' = 'reported', small = false) => {
  const d = `data-user="${esc(r.user_id)}" data-name="${esc(r.name ?? 'Trainer')}" data-role="${role}"`;
  const b = small ? 'btn small mini' : 'btn small';
  return banned
    ? `<button class="${b}" data-act="unban" ${d}>Lift</button>`
    : `<button class="${b}" data-act="24" ${d}>24 h</button><button class="${b}" data-act="168" ${d}>7 days</button>
       <button class="${b} danger" data-act="0" ${d}>Ban</button><button class="${b} ghost" data-act="name" ${d}>Reset name</button>`;
};

/** Clears the reported player's open reports without deleting them. Only on the reported row, never on reporters or the Suspended tab. */
export const dismissButton = (r: Reported) =>
  `<button class="btn small ghost" data-act="dismiss" data-user="${esc(r.user_id)}" data-name="${esc(r.name ?? 'Trainer')}" data-role="reported" data-reports="${r.reports}">Dismiss</button>`;

const checkReason = (c: Check) => {
  if (c.notes) return `${c.status ?? 'check'}: ${c.notes}`;
  if (c.status === 'invalid') return 'invalid: the uploads do not replay';
  if (c.status === 'final') return c.agrees ? 'final: the replay agrees with the recorded winner' : 'final: the replay disagrees with the recorded winner';
  if (c.status === 'forfeit') return c.cheater_is_reported ? 'forfeit: by the reported player' : 'forfeit: by the opponent';
  if (c.status === 'incomplete') return 'incomplete: the uploads end before the game does';
  if (c.queue === 'social') return 'Social match: no uploads';
  return c.has_evidence ? 'not judged yet' : 'no uploads';
};

/** The Cheat check cell: the tag, with a one-line reason (from the match that decided it) as its tooltip. */
export function cheatCell(checks: Check[] | null | undefined): string {
  const tag = cheatTag(checks);
  const list = checks ?? [];
  const pick = tag === 'flagged' ? list.find((c) => cheatTag([c]) === 'flagged')
    : tag === 'clean' ? list.find((c) => cheatTag([c]) === 'clean') : list[0];
  const reason = pick ? checkReason(pick) : 'no check from the server';
  const [cls, label] = tag === 'flagged' ? ['tag bad', 'Flagged'] : tag === 'clean' ? ['tag ok', 'Clean'] : ['tag', 'No check'];
  return `<span class="${cls}" title="${esc(reason)}">${label}</span>`;
}

/** Words for the confirm dialog: who it is about, and in which role. */
export const personLabel = (name: string, role: string | undefined) => (role === 'reporter' ? `${name} (the reporter)` : role === 'reported' ? `${name} (the reported player)` : name);

export function reportsHtml(rows: Reported[]): string {
  if (!rows.length) return '<p class="note">No reports in this period.</p>';
  return `<div class="scroll"><table class="reports"><thead><tr><th>Reported player</th><th>Cheat check</th><th>Reports</th><th>Reasons</th><th>Latest reports</th><th>Status</th><th>Actions on the reported player</th></tr></thead><tbody>
    ${sortReported(rows).map((r) => `<tr>
      <td><strong>${esc(r.name ?? '?')}</strong>${badName(r.name)}<small>${esc(r.user_id.slice(0, 8))}</small></td>
      <td>${cheatCell(r.checks)}</td>
      <td class="num"><strong>${r.reports} report${r.reports === 1 ? '' : 's'}</strong><small>${r.reporters} reporter${r.reporters === 1 ? '' : 's'}</small></td>
      <td>${Object.entries(r.reasons ?? {}).map(([k, n]) => `<span class="tag">${esc(k)} ${n}</span>`).join(' ')}</td>
      <td><ul class="latest">${(r.latest ?? []).slice(0, 4).map((l) => `<li>Reported by <b>${esc(l.from ?? '?')}</b>${badName(l.from)} · ${esc(l.reason)}${l.note ? ` · “${esc(l.note)}”` : ''} · <small>${esc(when(l.at))}</small>${
        l.from_id ? `<span class="rep-acts"><i>Reporter:</i> ${actions({ user_id: l.from_id, name: l.from }, false, 'reporter', true)}</span>` : ''}</li>`).join('')}</ul></td>
      <td>${r.banned_until ? `<span class="tag bad">suspended ${forever(r.banned_until) ? 'permanently' : `until ${esc(when(r.banned_until))}`}</span>` : '—'}${rankedQuitHtml(r.quit_offences, r.ranked_ban_until)}</td>
      <td class="acts">${actions(r, !!r.banned_until)}${dismissButton(r)}${clearRankedBanButton(r)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

export function bansHtml(rows: Ban[]): string {
  if (!rows.length) return '<p class="note">Nobody is suspended.</p>';
  return `<div class="scroll"><table><thead><tr><th>Player</th><th>Until</th><th>Why</th><th>Since</th><th></th></tr></thead><tbody>
    ${rows.map((b) => `<tr><td><strong>${esc(b.name ?? '?')}</strong>${badName(b.name)}<small>${esc(b.user_id.slice(0, 8))}</small></td>
      <td>${forever(b.until) ? 'permanent' : esc(when(b.until))}${rankedQuitHtml(b.quit_offences, b.ranked_ban_until)}</td>
      <td>${b.auto ? '<span class="tag">automatic</span> ' : ''}${esc(b.reason ?? '')}</td><td>${esc(when(b.since))}</td>
      <td class="acts">${actions(b, true)}${clearRankedBanButton(b)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

export interface JudgeShadowRow {
  day: string; browser_engine: string; n: number; final_n: number; incomplete_n: number; forfeit_n: number; invalid_n: number;
  agree_n: number; disagree_n: number; agree_rate: number | null; resync_matches: number; resync_disagree_n: number;
}
export interface JudgeShadow {
  rows: JudgeShadowRow[];
  backlog: { pending: number; running: number; failed: number; oldest_ready_s: number | null; unjudged: number };
}

export interface JudgeFlag {
  id: number; match_id: string; user_id: string | null; username: string | null; reason: string; detail: string | null; created_at: string; reviewed: boolean;
}

const FLAG_REASONS: Record<string, string> = {
  report_mismatch: 'Report differs from the replay',
  equivocation: 'Signed two versions of a frame',
  bad_upload: 'Fake or unreadable upload',
  false_report: 'Reported a result the log does not reach',
  desync_void: 'Stopped the game on a desync, match voided',
  invalid_verdict: 'Could not be judged, old rules applied',
  no_verdict: 'No verdict in time, old rules applied',
};

/** What the judge flagged for a person to look at. A flag is not a penalty. */
export function judgeFlagsHtml(flags: JudgeFlag[]): string {
  if (!flags.length) return '<p class="note">No flags.</p>';
  return `<div class="scroll"><table><thead><tr><th>When</th><th>Player</th><th>Why</th><th>Detail</th><th>Match</th></tr></thead><tbody>
    ${flags.map((f) => `<tr><td>${esc(when(f.created_at))}</td><td>${esc(f.username ?? (f.user_id ? f.user_id.slice(0, 8) : '–'))}</td>
      <td>${esc(FLAG_REASONS[f.reason] ?? f.reason)}</td><td>${esc(f.detail ?? '')}</td><td>${esc(f.match_id.slice(0, 8))}</td></tr>`).join('')}
  </tbody></table></div><p class="note">The replay can honestly differ from a game played on another browser, so read a flag alongside the player's history.</p>`;
}

/** The judge's shadow verdicts against what the players reported, per day and host browser engine. */
export function judgeShadowHtml(s: JudgeShadow): string {
  const b = s.backlog;
  const backlog = `<p class="note">Queue: ${b.pending} pending${b.oldest_ready_s === null ? '' : ` (oldest ready ${Math.round(b.oldest_ready_s)} s ago)`}, ${b.running} running, ${b.failed} failed. ${b.unjudged} finished with no verdict, mostly no uploads.</p>`;
  if (!s.rows.length) return `<p class="note">No verdicts yet.</p>${backlog}`;
  return `<div class="scroll"><table><thead><tr><th>Day (PT)</th><th>Host engine</th><th>Verdicts</th><th>Final</th><th>Agree</th><th>Disagree</th><th>Agree rate</th>
      <th>With resyncs</th><th>Resyncs + disagree</th><th>Incomplete</th><th>Forfeit</th><th>Invalid</th></tr></thead><tbody>
    ${s.rows.map((r) => `<tr><td>${esc(r.day)}</td><td>${esc(r.browser_engine)}</td><td>${r.n}</td><td>${r.final_n}</td><td>${r.agree_n}</td><td>${r.disagree_n}</td>
      <td>${r.agree_rate === null ? '–' : `${Math.round(r.agree_rate * 100)}%`}</td><td>${r.resync_matches}</td><td>${r.resync_disagree_n}</td>
      <td>${r.incomplete_n}</td><td>${r.forfeit_n}</td><td>${r.invalid_n}</td></tr>`).join('')}
  </tbody></table></div><p class="note">Shadow verdicts only: these changed no result. Disputes the judge decided are under “Judge flags”. Agree = the replay's winner is the match's winner; a void match counts as neither.
    “unknown” engine = the host sent no stats, or an older client.</p>${backlog}`;
}
