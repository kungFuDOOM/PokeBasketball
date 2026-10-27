// Cloudflare Turnstile bot checks, only when VITE_TURNSTILE_SITE_KEY is set:
// - before a new anonymous account is made, so one script can't mint unlimited accounts (Supabase Auth checks
//   that token: Auth → Bot and Abuse Protection). A returning player keeps their session and never sees it.
// - before online matchmaking, when the server asks for it (human.ts and the pokejam-human Edge Function).
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
export const CAPTCHA_ON = !!SITE_KEY;

interface Turnstile {
  render(el: HTMLElement, opts: { sitekey: string; callback(token: string): void; 'error-callback'(code?: string): void; theme?: string }): string;
  remove(id: string): void;
}
declare global {
  interface Window { turnstile?: Turnstile }
}

let loading: Promise<Turnstile> | null = null;
function load(): Promise<Turnstile> {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Bot check failed to load.')));
    s.onerror = () => { loading = null; reject(new Error('Bot check failed to load.')); };
    document.head.append(s);
  });
  return loading;
}

/** What a Turnstile error code means, for the message players (and whoever they screenshot it for) see. */
export function turnstileHint(code = ''): string {
  if (code === '110200') return "this site isn't on the widget's hostname list";
  if (code === '110100' || code === '110110') return 'the site key is wrong';
  if (code === '200500') return "the check couldn't load";
  if (/^(300|600)/.test(code)) return "the challenge wasn't passed";
  return '';
}

/** The message when Cloudflare's widget itself fails, with its error code. */
export function turnstileError(code?: string): Error {
  const hint = turnstileHint(code);
  return new Error(`Cloudflare's bot check failed (error ${code || 'unknown'}${hint ? `: ${hint}` : ''}). Try again.`);
}

/** Shows the bot check over the page and resolves with its token. */
export async function captchaToken(note = 'Quick check before your first online game.'): Promise<string> {
  const ts = await load();
  const box = document.createElement('div');
  box.className = 'captcha-overlay';
  box.innerHTML = '<div class="panel"><p class="note center"></p><div class="captcha-slot"></div></div>';
  box.querySelector('p')!.textContent = note;
  document.body.append(box);
  try {
    return await new Promise<string>((resolve, reject) => {
      const id = ts.render(box.querySelector<HTMLElement>('.captcha-slot')!, {
        sitekey: SITE_KEY!, theme: 'dark',
        callback: (token) => { ts.remove(id); resolve(token); },
        'error-callback': (code) => { ts.remove(id); reject(turnstileError(code)); },
      });
    });
  } finally {
    box.remove();
  }
}
