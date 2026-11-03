// Step-specific failure text and the small on-screen diagnostic code for the Phantom deeplink sign-in. Pure: no DOM at import.
// A code names the step and reason, never anything private: no ids, keys, addresses, nonces or tokens, and no raw server text.
//
//   PJ-<step>[-<http status>-<reason>] · <app|safari|tab> · <standalone signal> · b<build>      e.g. PJ-W3-400-CHAIN · app · sa:nav · b1a2b3c
//
// Safari reports a failure to the waiting app as a number in the relay (it must match ^-?[0-9]{1,6}$); RELAY_CODES and
// relayCodeOf/keyFromRelay map it both ways. See docs/phantom-mobile-signin.md for the table.

/** Where the failure happened: the standalone home-screen app, the Safari page finishing a handoff, or a normal browser tab. */
export type DiagContext = 'app' | 'safari' | 'tab';

/** Why the Supabase auth call failed, as a short token. */
export const AUTH_REASONS = ['OTHER', 'CHAIN', 'URI', 'DOMAIN', 'EXPIRED', 'SIG', 'RATE', 'NET', 'SRV', 'DISABLED'] as const;
export type AuthReason = (typeof AUTH_REASONS)[number];

/** Fixed step keys. W3-/RF- keys carry an HTTP status and an AuthReason on top (see authKey). */
const FIXED = {
  /** Phantom's connect answer was missing or could not be decrypted. */
  'CN-READ': { msg: "Phantom's connect answer couldn't be read. Try again.", relay: 100 },
  /** Phantom itself reported an error on the connect step. */
  'CN-PH': { msg: "Phantom couldn't finish connecting. Try again.", relay: 101 },
  /** Phantom's sign answer was missing, malformed or had a bad signature length. */
  'SG-READ': { msg: "Phantom's signature answer couldn't be read. Try again.", relay: 110 },
  /** Phantom itself reported an error on the signing step. */
  'SG-PH': { msg: "Phantom couldn't finish signing. Try again.", relay: 111 },
  'EXP': { msg: 'This sign-in expired. Try again.', relay: 120 },
  /** The signed message did not match this sign-in (wrong wallet or nonce). */
  'MIS': { msg: "That sign-in didn't match. Try again.", relay: 130 },
  /** The saved sign-in state was missing or from an older version of the game. */
  'STATE': { msg: "This sign-in couldn't be continued. Start it again.", relay: 131 },
  'CXL': { msg: 'Cancelled in Phantom.', relay: 4001 },
  /** Phantom reported an error and the code was not one we know (also what older builds send). */
  'PH-UNK': { msg: "Phantom couldn't finish that. Try again.", relay: 1 },
  /** Safari signed in but could not leave the result for the app. Local to Safari: it cannot be relayed. */
  'HO-PUT': { msg: "Couldn't hand the sign-in back to the app. Go back to PokeJam and try again.", relay: null },
  /** Safari could not pass Phantom's answer to the tab that holds the key. Local. */
  'HO-PASS': { msg: "Couldn't pass Phantom's answer back to PokeJam. Go back to PokeJam and try again.", relay: null },
  /** The app got the handed-back box but could not open it. Local to the app. */
  'HB-READ': { msg: "The app couldn't read the handed-back sign-in. Try again.", relay: null },
  /** Anything unexpected. */
  'UNK': { msg: "Couldn't sign in with Phantom. Try again.", relay: null },
} as const;
export type FixedKey = keyof typeof FIXED;

const AUTH_RE = /^(W3|RF)-(\d{1,3})-([A-Z]+)$/;

export const authKey = (step: 'W3' | 'RF', status: number, reason: AuthReason): string =>
  `${step}-${Math.max(0, Math.min(999, Math.trunc(status) || 0))}-${reason}`;

/** Maps a Supabase auth error (or anything thrown by the call) to an HTTP status and a short reason. Reads only status, code and message. */
export function classifyAuthError(err: unknown): { status: number; reason: AuthReason } {
  const e = (err && typeof err === 'object' ? err : {}) as { status?: unknown; code?: unknown; message?: unknown; name?: unknown };
  const status = typeof e.status === 'number' && Number.isFinite(e.status) ? Math.max(0, Math.min(999, Math.trunc(e.status))) : 0;
  const text = `${typeof e.code === 'string' ? e.code : ''} ${typeof e.message === 'string' ? e.message : ''}`.toLowerCase();
  const name = typeof e.name === 'string' ? e.name.toLowerCase() : '';
  let reason: AuthReason = 'OTHER';
  if (status === 429 || /rate.?limit/.test(text)) reason = 'RATE';
  else if (status === 0 || /fetch/.test(name) || /failed to fetch|networkerror|load failed/.test(text)) reason = 'NET';
  else if (/chain id/.test(text)) reason = 'CHAIN';
  else if (/domain/.test(text)) reason = 'DOMAIN';
  else if (/\buri\b|redirect/.test(text)) reason = 'URI';
  else if (/expir|not before|issued at|too old|in the future/.test(text)) reason = 'EXPIRED';
  else if (/signature|verif/.test(text)) reason = 'SIG';
  else if (/disabled|not enabled/.test(text)) reason = 'DISABLED';
  else if (status >= 500) reason = 'SRV';
  return { status, reason };
}

export const isKnownKey = (k: string): boolean => k in FIXED || AUTH_RE.test(k);

/** The plain-words message for a step key. */
export function diagMessage(key: string): string {
  const m = AUTH_RE.exec(key);
  if (m) {
    return m[1] === 'W3'
      ? 'Signing in was refused by the server. Try again.'
      : "The app couldn't use the handed-back sign-in. Try again.";
  }
  return (FIXED as Record<string, { msg: string }>)[key]?.msg ?? FIXED.UNK.msg;
}

// ---------- Relay (Safari -> waiting app) ----------

const RELAY_RE = /^-?[0-9]{1,6}$/;
/** Server-refused sign-ins in Safari: 20000 + reason index * 1000 + HTTP status (0 = no answer). */
const W3_BASE = 20000;

/** The number Safari leaves in the relay for a failure. Always matches ^-?[0-9]{1,6}$. Unreportable steps fall back to 1. */
export function relayCodeOf(key: string): string {
  const m = AUTH_RE.exec(key);
  if (m && m[1] === 'W3') {
    const idx = Math.max(0, AUTH_REASONS.indexOf(m[3] as AuthReason));
    return String(W3_BASE + idx * 1000 + Number(m[2]));
  }
  const f = (FIXED as Record<string, { relay: number | null }>)[key];
  return String(f?.relay ?? 1);
}

/** The step key for a relay error code, so the app shows the same message and code as Safari would. Unknown codes are PH-UNK. */
export function keyFromRelay(code: string): string {
  if (!RELAY_RE.test(code)) return 'PH-UNK';
  const n = Number(code);
  if (n >= W3_BASE && n < W3_BASE + AUTH_REASONS.length * 1000) {
    const off = n - W3_BASE;
    return authKey('W3', off % 1000, AUTH_REASONS[Math.floor(off / 1000)]);
  }
  for (const [k, v] of Object.entries(FIXED)) if (v.relay === n) return k;
  return 'PH-UNK';
}

// ---------- The code on screen ----------

/** Short, printable build id from VITE_BUILD_ID (the commit, usually). Only [A-Za-z0-9._-], at most 7 characters. */
export function shortBuild(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 7) : '';
  return s && s !== 'unknown' ? s : 'dev';
}

/** `sa:<signal>` or `sa:no`: whether isStandalone() was true and which signal said so. */
export const standaloneTag = (signal: string | null): string => `sa:${signal ?? 'no'}`;

export function formatDiag(o: { key: string; ctx: DiagContext; standalone: string | null; build: string }): string {
  return `PJ-${isKnownKey(o.key) ? o.key : 'UNK'} · ${o.ctx} · ${standaloneTag(o.standalone)} · b${shortBuild(o.build)}`;
}
