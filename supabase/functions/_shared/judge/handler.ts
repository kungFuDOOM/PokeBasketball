// pokejam-judge: the winner check on demand, for the moderation page (admin.html).
//
// A moderator's page calls it with their own session (supabase.functions.invoke) and the reported matches that have
// uploads but no verdict yet. For each one it reads both players' uploads (pokejam_match_evidence, service role
// only), merges their signed inputs under the setup and keys from the match row (pokejam_match_setup, migration
// 20261128; mergeEvidence: an uploader can't pick the game or the keys they're judged by), replays the match with
// judge() and saves the result (pokejam_record_verdict, which maps the judge's sides to player ids). Matches already
// judged, or with no uploads (Social), are skipped. One bad match doesn't stop the rest.
import { mergeEvidence, unpack } from '../../../../src/multiplayer/shared/evidence.ts';
import { judge as realJudge, type Evidence, type MatchKeys, type MatchSetup, type Verdict } from '../../../../src/multiplayer/shared/winnerCheck.ts';
import { ENGINE_VERSION } from '../../../../src/game/types.ts';

/** Most matches judged per call. */
export const MAX_MATCHES = 20;
/** Largest upload read (pokejam_match_evidence allows 4,000,000 bytes). */
export const MAX_UPLOAD_CHARS = 4_000_000;
/** Largest an upload may unzip to. A long game is a few MB of JSON. */
export const MAX_UNZIPPED_BYTES = 32_000_000;

export interface JudgeConfig {
  /** Sites allowed to call (exact origins). Empty: any origin (the session and the admin check still apply). */
  origins: string[];
}

export interface RecordArgs {
  match: string;
  status: Verdict['status'];
  winnerSide: 0 | 1 | null;
  cheaterSide: 0 | 1 | null;
  scoreHost: number;
  scoreGuest: number;
  ticks: number;
  notes: string;
  lastFrameHost: number;
  lastFrameGuest: number;
}

export interface JudgeDeps {
  /** Whether the caller's session belongs to a moderator (pokejam_is_admin, called as them). */
  isAdmin(jwt: string): Promise<boolean>;
  /**
   * The match's game and registered keys, from the server's row (judgeSetupFromRow over pokejam_match_setup), or null
   * when there is no such match. `setup` is null when the row can't build the game yet.
   */
  setupOf(matchId: string): Promise<{ setup: MatchSetup | null; keys: { host_key: string | null; guest_key: string | null } } | null>;
  hasVerdict(matchId: string): Promise<boolean>;
  /** The match's uploads (pack() strings), oldest first. */
  uploadsOf(matchId: string): Promise<string[]>;
  /** pokejam_record_verdict. */
  record(v: RecordArgs): Promise<void>;
  /** The judge; tests may stand one in. */
  judge?: (ev: Evidence) => Promise<Verdict>;
}

export type MatchResult =
  | { match_id: string; result: 'recorded'; status: Verdict['status'] }
  | { match_id: string; result: 'skipped'; reason: string }
  | { match_id: string; result: 'error'; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function judgeConfig(get: (k: string) => string | undefined): JudgeConfig {
  return { origins: (get('JUDGE_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean) };
}

/** Judge one match and save the verdict. */
export async function judgeMatch(id: string, deps: JudgeDeps): Promise<MatchResult> {
  if (await deps.hasVerdict(id)) return { match_id: id, result: 'skipped', reason: 'already judged' };
  const uploads = await deps.uploadsOf(id);
  if (!uploads.length) return { match_id: id, result: 'skipped', reason: 'no evidence' };
  const m = await deps.setupOf(id);
  if (!m) return { match_id: id, result: 'skipped', reason: 'no such match' };
  if (!m.keys.host_key || !m.keys.guest_key) return { match_id: id, result: 'skipped', reason: 'no keys registered' };
  if (uploads.some((u) => u.length > MAX_UPLOAD_CHARS)) return { match_id: id, result: 'skipped', reason: 'evidence too large' };
  const evs = await Promise.all(uploads.slice(0, 2).map((u) => unpack(u, MAX_UNZIPPED_BYTES)));
  const invalid = async (note: string): Promise<MatchResult> => {
    await deps.record({
      match: id, status: 'invalid', winnerSide: null, cheaterSide: null, scoreHost: 0, scoreGuest: 0, ticks: 0, notes: note, lastFrameHost: 0, lastFrameGuest: 0,
    });
    return { match_id: id, result: 'recorded', status: 'invalid' };
  };
  // The setup is the server's, but the engine a match was played on is only in the uploads. If the judge deployed
  // mid-match, replaying on the new engine would silently be a different game.
  const old = evs.find((e) => e?.setup?.engineVersion !== ENGINE_VERSION);
  if (old) return invalid(`recorded on engine v${old.setup?.engineVersion}, this judge runs engine v${ENGINE_VERSION}`);
  if (!m.setup) return invalid('the match row has no seed or rosters');
  const keys: MatchKeys = [m.keys.host_key, m.keys.guest_key];
  const v = await (deps.judge ?? realJudge)(mergeEvidence(evs[0], evs[1], keys, m.setup));
  await deps.record({
    match: id, status: v.status, winnerSide: v.winner, cheaterSide: v.cheater ?? null,
    scoreHost: v.score[0], scoreGuest: v.score[1], ticks: v.ticks, notes: v.notes.join('\n'),
    lastFrameHost: v.lastFrame[0], lastFrameGuest: v.lastFrame[1],
  });
  return { match_id: id, result: 'recorded', status: v.status };
}

export async function judgeHandler(req: Request, cfg: JudgeConfig, deps: JudgeDeps): Promise<Response> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = !cfg.origins.length || cfg.origins.includes(origin);
  const cors: Record<string, string> = {
    'access-control-allow-origin': allowed ? (origin || '*') : 'null',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!allowed) return json({ error: 'origin not allowed' }, 403);
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!jwt) return json({ error: 'sign in first' }, 401);
  if (!(await deps.isAdmin(jwt).catch(() => false))) return json({ error: 'moderators only' }, 403);
  let ids: unknown;
  try {
    ids = ((await req.json()) as { match_ids?: unknown } | null)?.match_ids;
  } catch { /* handled below */ }
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string' && UUID.test(x))) return json({ error: 'match_ids must be match ids' }, 400);
  const batch = [...new Set(ids as string[])].slice(0, MAX_MATCHES);
  const results: MatchResult[] = [];
  for (const id of batch) {
    try {
      results.push(await judgeMatch(id, deps));
    } catch (e) {
      console.error(`pokejam-judge: match ${id}:`, e);
      results.push({ match_id: id, result: 'error', reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ ok: true, results });
}
