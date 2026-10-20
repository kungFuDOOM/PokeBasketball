export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
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
