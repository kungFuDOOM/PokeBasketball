export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Three-letter scorebug abbreviation from a team name. */
export const abbr = (name: string) => (name.replace(/[^a-z0-9]/gi, '').slice(0, 3) || 'YOU').toUpperCase();

export function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 2K-style card tier for an overall rating. */
export function tier(ovr: number): string {
  if (ovr >= 90) return 'dmd';
  if (ovr >= 85) return 'ame';
  if (ovr >= 80) return 'rby';
  if (ovr >= 75) return 'sap';
  if (ovr >= 70) return 'emr';
  if (ovr >= 60) return 'gld';
  return 'brz';
}
