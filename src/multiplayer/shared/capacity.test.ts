import { describe, expect, it } from 'vitest';
import { BUSY_MESSAGE, BotCheckError, BusyError, classify, isBusy } from './capacity';
import { turnstileError } from './captcha';
import { OnlineError } from './onlineMatchService';

const http = (status: number) => ({ name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: new Response('{}', { status }) });

describe('capacity errors become one clear message', () => {
  it('says the busy message for Realtime, Postgres, Auth and HTTP capacity signals', () => {
    expect(BUSY_MESSAGE).toBe('Online is busy right now — try again in a few minutes. Solo games still work.');
    const busy: unknown[] = [
      new BusyError('TIMED_OUT'),
      new Error('too_many_connections'),
      new Error('Too many channels'),
      new Error('TooManyJoins: limit reached'),
      new Error('ConnectionRateLimitReached'),
      new Error('Request rate limit reached'),
      new OnlineError('boom', undefined, 429),
      new OnlineError('boom', undefined, 503),
      new OnlineError('remaining connection slots are reserved', '53300'),
      http(429), http(503),
      Object.assign(new Error('x'), { status: 504 }),
      new Error('The server refused the bot check (503 unavailable). Try again.'),
    ];
    for (const e of busy) {
      expect(isBusy(e), String((e as Error).message)).toBe(true);
      expect(classify(e)).toEqual({ kind: 'busy', message: BUSY_MESSAGE });
    }
  });

  it('keeps bot-check failures distinct from busy', () => {
    for (const e of [turnstileError('110200'), new BotCheckError(), new Error('The server refused the bot check (403 check failed). Try again.'), new Error('human check needed'), new Error('captcha verification process failed')]) {
      expect(classify(e).kind, e.message).toBe('botcheck');
      expect(classify(e).message).not.toBe(BUSY_MESSAGE);
    }
    expect(classify(turnstileError('110200')).message).toMatch(/Cloudflare's bot check failed/);
  });

  it('leaves ordinary errors alone', () => {
    expect(classify(new OnlineError('room not found', 'P0001', 400))).toEqual({ kind: 'other', message: 'room not found' });
    expect(classify(new Error('Anonymous sign-ins are disabled')).message).toBe('Online sign-in is switched off on the server right now.');
    expect(classify(new Error('JWT expired')).kind).toBe('session');
    expect(classify(undefined).message).toBe('Something went wrong.');
  });
});
