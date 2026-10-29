// The Reported and Suspended tables of the moderation page, as pure HTML builders (so they can be tested without a page).
import { isNameBlocked } from '../nameFilter';
import { esc } from '../util';

export interface ReportEntry { reason: string; note: string | null; at: string; from: string | null; /** The reporter's id: present once migration 20261116 is applied. */ from_id?: string | null }
export interface Reported {
  user_id: string; name: string | null; reporters: number; reports: number; reasons: Record<string, number> | null;
  latest: ReportEntry[] | null; last_at: string; banned_until: string | null;
}
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

/** Words for the confirm dialog: who it is about, and in which role. */
export const personLabel = (name: string, role: string | undefined) => (role === 'reporter' ? `${name} (the reporter)` : role === 'reported' ? `${name} (the reported player)` : name);

export function reportsHtml(rows: Reported[]): string {
  if (!rows.length) return '<p class="note">No reports in this period.</p>';
  return `<div class="scroll"><table><thead><tr><th>Reported player</th><th>Reporters</th><th>Reasons</th><th>Latest reports</th><th>Status</th><th>Actions on the reported player</th></tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td><strong>${esc(r.name ?? '?')}</strong>${badName(r.name)}<small>${esc(r.user_id.slice(0, 8))}</small></td>
      <td class="num">${r.reporters}<small>${r.reports} reports</small></td>
      <td>${Object.entries(r.reasons ?? {}).map(([k, n]) => `<span class="tag">${esc(k)} ${n}</span>`).join(' ')}</td>
      <td><ul class="latest">${(r.latest ?? []).slice(0, 4).map((l) => `<li>Reported by <b>${esc(l.from ?? '?')}</b>${badName(l.from)} · ${esc(l.reason)}${l.note ? ` · “${esc(l.note)}”` : ''} · <small>${esc(when(l.at))}</small>${
        l.from_id ? `<span class="rep-acts"><i>Reporter:</i> ${actions({ user_id: l.from_id, name: l.from }, false, 'reporter', true)}</span>` : ''}</li>`).join('')}</ul></td>
      <td>${r.banned_until ? `<span class="tag bad">suspended ${forever(r.banned_until) ? 'permanently' : `until ${esc(when(r.banned_until))}`}</span>` : '—'}</td>
      <td class="acts">${actions(r, !!r.banned_until)}</td></tr>`).join('')}
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
