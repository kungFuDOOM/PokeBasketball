import { describe, expect, it } from 'vitest';
import { base58Encode, randomBytes } from '../../supabase/functions/_shared/pack/bytes.ts';
import {
  AUTH_REASONS, authKey, classifyAuthError, diagMessage, formatDiag, keyFromRelay, relayCodeOf, shortBuild,
} from './phantomDiag';
import { PhantomLinkError, authError, phantomErrorFor, stepError } from './phantomLink';
import { sheetHtml } from './phantomView';

const RELAY_RE = /^-?[0-9]{1,6}$/;
const FIXED_KEYS = ['CN-READ', 'CN-PH', 'SG-READ', 'SG-PH', 'EXP', 'MIS', 'STATE', 'CXL', 'PH-UNK', 'HO-PUT', 'HO-PASS', 'HB-READ', 'UNK'];

describe('classifying a Supabase auth error', () => {
  const cases: [string, { status?: number; code?: string; message?: string; name?: string }, number, string][] = [
    ['the live 400', { status: 400, code: 'validation_failed', message: 'siws: Chain ID is not valid' }, 400, 'CHAIN'],
    ['a redirect URI not on the list', { status: 400, code: 'validation_failed', message: 'siws: URI not allowed' }, 400, 'URI'],
    ['a domain mismatch', { status: 400, code: 'validation_failed', message: 'siws: Domain does not match URI host' }, 400, 'DOMAIN'],
    ['an expired message', { status: 400, code: 'validation_failed', message: 'siws: message has expired' }, 400, 'EXPIRED'],
    ['a stale Issued At', { status: 400, message: 'Issued At is too old' }, 400, 'EXPIRED'],
    ['a bad signature', { status: 401, code: 'validation_failed', message: 'signature verification failed' }, 401, 'SIG'],
    ['the rate limit', { status: 429, code: 'over_request_rate_limit', message: 'Request rate limit reached' }, 429, 'RATE'],
    ['no network (supabase-js status 0)', { status: 0, name: 'AuthRetryableFetchError', message: 'Failed to fetch' }, 0, 'NET'],
    ['a thrown TypeError', { name: 'TypeError', message: 'Load failed' }, 0, 'NET'],
    ['web3 switched off', { status: 400, code: 'provider_disabled', message: 'Web3 provider is disabled' }, 400, 'DISABLED'],
    ['a server error', { status: 502, message: 'bad gateway' }, 502, 'SRV'],
    ['something else', { status: 400, message: 'huh' }, 400, 'OTHER'],
  ];
  for (const [name, err, status, reason] of cases) it(`${name} -> ${status} ${reason}`, () => expect(classifyAuthError(err)).toEqual({ status, reason }));
  it('copes with nothing at all', () => {
    expect(classifyAuthError(null)).toEqual({ status: 0, reason: 'NET' });
    expect(classifyAuthError('boom')).toEqual({ status: 0, reason: 'NET' });
  });
  it('builds a key from the status and reason, never from the raw text', () => {
    expect(authKey('W3', 400, 'CHAIN')).toBe('W3-400-CHAIN');
    expect(authKey('RF', 1234, 'OTHER')).toBe('RF-999-OTHER');
    const e = authError('W3', { status: 400, code: 'validation_failed', message: 'siws: Chain ID is not valid eyJhbGciOi.secret.token' });
    expect(e.diag).toBe('W3-400-CHAIN');
    expect(e.message).not.toMatch(/eyJ|secret|Chain ID/);
  });
});

describe('step-specific messages', () => {
  it('says which step failed, in plain words', () => {
    expect(diagMessage('CN-READ')).toMatch(/connect answer couldn't be read/);
    expect(diagMessage('SG-READ')).toMatch(/signature answer couldn't be read/);
    expect(diagMessage('W3-400-CHAIN')).toMatch(/refused by the server/);
    expect(diagMessage('RF-401-OTHER')).toMatch(/app couldn't use the handed-back sign-in/);
    expect(diagMessage('HO-PUT')).toMatch(/hand the sign-in back to the app/);
    expect(diagMessage('EXP')).toMatch(/expired/);
    expect(diagMessage('CXL')).toMatch(/Cancelled in Phantom/);
    expect(diagMessage('MIS')).toMatch(/didn't match/);
    expect(diagMessage('nonsense')).toBe(diagMessage('UNK'));
  });
  it('every key has its own message; only cancel is "cancelled"', () => {
    const msgs = new Set(FIXED_KEYS.map(diagMessage));
    expect(msgs.size).toBe(FIXED_KEYS.length);
    expect(stepError('CXL').cancelled).toBe(true);
    for (const k of FIXED_KEYS.filter((k) => k !== 'CXL')) expect(stepError(k).cancelled).toBe(false);
    expect(new PhantomLinkError('x').cancelled).toBe(false);
    expect(new PhantomLinkError('x', true).cancelled).toBe(true);
  });
  it("maps Phantom's own error codes by step, 4001 is the player cancelling", () => {
    expect(phantomErrorFor('4001', 'connect')).toMatchObject({ diag: 'CXL', cancelled: true });
    expect(phantomErrorFor('-32603', 'connect').diag).toBe('CN-PH');
    expect(phantomErrorFor('-32603', 'sign').diag).toBe('SG-PH');
    expect(phantomErrorFor('1', 'sign').diag).toBe('PH-UNK'); // what builds before this one sent
  });
});

describe('the code Safari leaves for the waiting app', () => {
  const keys = [...FIXED_KEYS, ...AUTH_REASONS.flatMap((r) => [authKey('W3', 0, r), authKey('W3', 400, r), authKey('W3', 999, r)])];
  it('is always a number the relay accepts', () => {
    for (const k of keys) expect(relayCodeOf(k), k).toMatch(RELAY_RE);
  });
  it('keeps 4001 for cancel and round-trips every reportable step', () => {
    expect(relayCodeOf('CXL')).toBe('4001');
    for (const k of keys) {
      if (['HO-PUT', 'HO-PASS', 'HB-READ', 'UNK'].includes(k)) expect(keyFromRelay(relayCodeOf(k)), k).toBe('PH-UNK'); // local to one page: not reportable
      else expect(keyFromRelay(relayCodeOf(k)), k).toBe(k);
    }
  });
  it('gives each reportable step its own number', () => {
    const nums = keys.filter((k) => !['HO-PUT', 'HO-PASS', 'HB-READ', 'UNK'].includes(k)).map(relayCodeOf);
    expect(new Set(nums).size).toBe(nums.length);
  });
  it('treats the old "1", other numbers and junk as an unknown Phantom error', () => {
    for (const c of ['1', '0', '-32603', '99999', '19999', '30000', '', 'x', '1e3']) expect(keyFromRelay(c), c).toBe('PH-UNK');
  });
});

describe('the code on screen', () => {
  const sa = 'nav';
  it('names step, context, standalone signal and build', () => {
    expect(formatDiag({ key: 'W3-400-CHAIN', ctx: 'app', standalone: sa, build: '1a2b3cdeadbeef' })).toBe('PJ-W3-400-CHAIN · app · sa:nav · b1a2b3cd');
    expect(formatDiag({ key: 'CN-READ', ctx: 'safari', standalone: null, build: undefined as unknown as string })).toBe('PJ-CN-READ · safari · sa:no · bdev');
    expect(formatDiag({ key: 'EXP', ctx: 'tab', standalone: 'standalone', build: 'dev' })).toBe('PJ-EXP · tab · sa:standalone · bdev');
  });
  it('falls back to dev for a missing build and strips odd characters', () => {
    expect(shortBuild(undefined)).toBe('dev');
    expect(shortBuild('unknown')).toBe('dev');
    expect(shortBuild('')).toBe('dev');
    expect(shortBuild('a b<c>"d')).toBe('abcd');
    expect(shortBuild('0123456789abcdef')).toBe('0123456');
  });
  it('an unknown key shows as UNK, so nothing free-form can reach the screen', () => {
    expect(formatDiag({ key: 'ADDR 7EcDhSY', ctx: 'tab', standalone: null, build: 'x' })).toMatch(/^PJ-UNK · /);
  });
  it('never carries ids, keys, addresses, nonces or tokens', () => {
    const secret = base58Encode(randomBytes(32));
    const err = authError('W3', { status: 400, message: `siws ${secret} 7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV` });
    const html = sheetHtml({ kind: 'failed', tone: 'bad', text: err.message, diag: formatDiag({ key: err.diag!, ctx: 'app', standalone: 'nav', build: 'abc1234' }) });
    expect(html).not.toContain(secret);
    expect(html).not.toContain('7EcDhSY');
  });
  it('the failed sheet shows the message and the code under it, and no code when there is none', () => {
    const html = sheetHtml({ kind: 'failed', tone: 'bad', text: 'Signing in was refused by the server. Try again.', diag: 'PJ-W3-400-CHAIN · app · sa:nav · babc1234' });
    expect(html).toMatch(/role="alert">Signing in was refused[^<]*<\/p><p class="ph-diag" data-diag>PJ-W3-400-CHAIN · app · sa:nav · babc1234<\/p>/);
    expect(sheetHtml({ kind: 'failed', tone: 'bad', text: 'x' })).not.toContain('ph-diag');
  });
});
