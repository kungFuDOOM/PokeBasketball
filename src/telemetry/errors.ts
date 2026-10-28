// Crash reports: uncaught errors and rejected promises go to the game's Supabase project (pokejam_report_error,
// migration 20261030), so a launch-day crash shows up without waiting for a player to say so. Only in builds that
// have Supabase configured; nothing else is sent, and no third-party script is loaded. What's sent: the error
// message and stack, the page path, the build id and the browser's user agent. No account, no game data.

const MAX_PER_PAGE = 10;

export interface ReportDeps {
  send(body: Record<string, string | null>): Promise<unknown>;
  build: string;
  path(): string;
  ua: string;
}

export interface Reporter {
  report(err: unknown): void;
  readonly sent: number;
}

/** Turns errors into at most MAX_PER_PAGE reports, each distinct error once, skipping browser-extension noise. */
export function makeReporter(d: ReportDeps): Reporter {
  const seen = new Set<string>();
  let sent = 0;
  return {
    get sent() { return sent; },
    report(err: unknown) {
      const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : safeString(err));
      const message = `${e.name}: ${e.message}`.slice(0, 300);
      const stack = (e.stack ?? '').slice(0, 2000);
      // Extensions and injected scripts throw on every page; they aren't our crashes.
      if (/(chrome|moz|safari(-web)?)-extension:\/\//.test(stack) || /^Script error\.?$/.test(e.message)) return;
      const key = `${message}|${stack.split('\n')[1] ?? ''}`;
      if (seen.has(key) || sent >= MAX_PER_PAGE) return;
      seen.add(key);
      sent++;
      void d.send({ p_message: message, p_stack: stack || null, p_path: d.path().slice(0, 200), p_build: d.build, p_ua: d.ua.slice(0, 200) }).catch(() => {});
    },
  };
}

function safeString(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

/** Start reporting (once, at startup). A no-op without Supabase. */
export function initErrorReports(): Reporter | null {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !key || import.meta.env.DEV) return null;
  const reporter = makeReporter({
    build: (import.meta.env.VITE_BUILD_ID as string | undefined) ?? 'unknown',
    path: () => location.pathname + location.search.replace(/([?&])(code|token|key)=[^&]*/gi, '$1$2=…'),
    ua: navigator.userAgent,
    // A plain REST call, so the game's main bundle doesn't need supabase-js.
    send: (body) => fetch(`${url}/rest/v1/rpc/pokejam_report_error`, {
      method: 'POST', keepalive: true,
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  window.addEventListener('error', (e) => reporter.report(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reporter.report(e.reason));
  return reporter;
}
