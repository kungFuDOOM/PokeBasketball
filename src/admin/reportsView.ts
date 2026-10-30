// The Reported and Suspended tables of the moderation page, as pure HTML builders (so they can be tested without a page).
import { isNameBlocked } from '../nameFilter';
import { esc } from '../util';
import { cheatTag, sortReported, type MatchCheck } from './cheatTag';

export interface ReportEntry { reason: string; note: string | null; at: string; from: string | null; /** The reporter's id: present once migration 20261116 is applied. */ from_id?: string | null }
export interface Reported {
  user_id: string; name: string | null; reporters: number; reports: number; reasons: Record<string, number> | null;
  latest: ReportEntry[] | null; last_at: string; banned_until: string | null;
  /** One entry per reported match: present once migration 20261123 is applied. Without it the row shows "No check". */
  checks?: Check[] | null;
}
/** A match check; `notes` (the judge's reason) is used for the tooltip when the server sends it. */
export type Check = MatchCheck & { notes?: string | null };
export interface Ban { user_id: string; name: string | null; until: string; reason: string | null; auto: boolean; since: string }

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
      <td>${r.banned_until ? `<span class="tag bad">suspended ${forever(r.banned_until) ? 'permanently' : `until ${esc(when(r.banned_until))}`}</span>` : '—'}</td>
      <td class="acts">${actions(r, !!r.banned_until)}${dismissButton(r)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

export function bansHtml(rows: Ban[]): string {
  if (!rows.length) return '<p class="note">Nobody is suspended.</p>';
  return `<div class="scroll"><table><thead><tr><th>Player</th><th>Until</th><th>Why</th><th>Since</th><th></th></tr></thead><tbody>
    ${rows.map((b) => `<tr><td><strong>${esc(b.name ?? '?')}</strong>${badName(b.name)}<small>${esc(b.user_id.slice(0, 8))}</small></td>
      <td>${forever(b.until) ? 'permanent' : esc(when(b.until))}</td>
      <td>${b.auto ? '<span class="tag">automatic</span> ' : ''}${esc(b.reason ?? '')}</td><td>${esc(when(b.since))}</td>
      <td class="acts">${actions(b, true)}</td></tr>`).join('')}
  </tbody></table></div>`;
}
