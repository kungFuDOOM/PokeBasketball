// What went wrong online, in words a player can act on. "Busy" (Supabase connection, channel or rate limits, 429/503)
// is kept apart from a failed bot check, which has its own retry. Solo play never touches any of this.

export const BUSY_MESSAGE = 'Online is busy right now — try again in a few minutes. Solo games still work.';

/** Realtime or the API is at capacity (also: joining the match channel failed on every retry). */
export class BusyError extends Error {
  constructor(public detail = '') {
    super(BUSY_MESSAGE);
    this.name = 'BusyError';
  }
}

/** The bot check (Turnstile, or its server side) failed or was not passed; the player can try again. */
export class BotCheckError extends Error {
  constructor(message = "The bot check didn't go through. Try again.") {
    super(message);
    this.name = 'BotCheckError';
  }
}

export type ProblemKind = 'busy' | 'botcheck' | 'session' | 'other';
export interface Problem { kind: ProblemKind; message: string }

/** Capacity and rate-limit signals from Supabase Realtime, PostgREST, Auth and Edge Functions. */
const BUSY_TEXT = /too[_ ]many[_ ](connections|channels|joins|requests|clients)|TooManyJoins|TooManyChannels|TooManyConnections|ConnectionRateLimitReached|ChannelRateLimitReached|ClientJoinRateLimitReached|JoinsPerSecond|rate limit|over_request_rate_limit|service unavailable|temporarily unavailable|gateway time-?out/i;
/** A capacity refusal from the bot-check function itself ("... refused the bot check (503 ...)"). */
const BOT_BUSY = /refused the bot check \((429|50[234])\b/;
const BOT_TEXT = /bot check|human check|captcha|turnstile/i;
const SESSION_TEXT = /jwt expired|invalid jwt|jwt.*(malformed|invalid)|refresh token|session (expired|missing)|not authenticated/i;
const BUSY_STATUS = new Set([429, 502, 503, 504]);
/** Postgres: too_many_connections, and Supavisor/PostgREST pool exhaustion. */
const BUSY_CODES = new Set(['53300', '53400', 'over_request_rate_limit', 'too_many_connections', 'PGRST000', 'PGRST003']);

/** An error's HTTP status and code, wherever the library put them (error.status, error.code, a Response in error.context). */
function infoOf(e: unknown): { status?: number; code?: string; message: string } {
  const x = e as { status?: unknown; code?: unknown; message?: unknown; context?: unknown } | null | undefined;
  const status = typeof x?.status === 'number' ? x.status : x?.context instanceof Response ? x.context.status : undefined;
  return { status, code: typeof x?.code === 'string' ? x.code : undefined, message: typeof x?.message === 'string' ? x.message : typeof e === 'string' ? e : '' };
}

export function isBusy(e: unknown): boolean {
  if (e instanceof BusyError) return true;
  if (e instanceof BotCheckError) return false;
  const { status, code, message } = infoOf(e);
  if (BOT_BUSY.test(message)) return true;
  // A bot check that failed stays a bot-check message, whatever else it mentions.
  if (BOT_TEXT.test(message)) return false;
  return (status !== undefined && BUSY_STATUS.has(status)) || (code !== undefined && BUSY_CODES.has(code)) || BUSY_TEXT.test(message);
}

export function isBotCheck(e: unknown): boolean {
  if (e instanceof BotCheckError) return true;
  const { message } = infoOf(e);
  return !(e instanceof BusyError) && !BOT_BUSY.test(message) && BOT_TEXT.test(message);
}

/** Sorts any error into busy / bot check / expired session / other, with the message to show. */
export function classify(e: unknown): Problem {
  if (isBusy(e)) return { kind: 'busy', message: BUSY_MESSAGE };
  const { message } = infoOf(e);
  if (isBotCheck(e)) return { kind: 'botcheck', message: message || new BotCheckError().message };
  if (SESSION_TEXT.test(message)) return { kind: 'session', message: 'Your online session expired. Try again.' };
  if (/anonymous/i.test(message) && /disabled|not allowed/i.test(message)) return { kind: 'other', message: 'Online sign-in is switched off on the server right now.' };
  return { kind: 'other', message: message || 'Something went wrong.' };
}

/** Realtime channel join states that mean it did not work. */
export const isChannelFailure = (status: string) => status === 'CHANNEL_ERROR' || status === 'TIMED_OUT';
