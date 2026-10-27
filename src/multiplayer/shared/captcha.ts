// Cloudflare Turnstile bot checks, only when VITE_TURNSTILE_SITE_KEY is set:
// - before a new anonymous account is made, so one script can't mint unlimited accounts (Supabase Auth checks
//   that token: Auth → Bot and Abuse Protection). A returning player keeps their session and never sees it.
// - before online matchmaking, when the server asks for it (human.ts and the pokejam-human Edge Function).
import { BotCheckError } from './capacity';

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
export const CAPTCHA_ON = !!SITE_KEY;
/** An unanswered check gives up after this long (the player can also cancel it), so it is never a dead end. */
const CHECK_TIMEOUT_MS = 120_000;
const LOAD_FAILED = 'The bot check failed to load. Check your connection and try again.';

interface Turnstile {
  render(el: HTMLElement, opts: {
    sitekey: string; callback(token: string): void; 'error-callback'(code?: string): void;
    'timeout-callback'?(): void; 'expired-callback'?(): void; 'unsupported-callback'?(): void; theme?: string;
  }): string;
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
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : (loading = null, reject(new BotCheckError(LOAD_FAILED))));
    s.onerror = () => { loading = null; s.remove(); reject(new BotCheckError(LOAD_FAILED)); };
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
export function turnstileError(code?: string): BotCheckError {
  const hint = turnstileHint(code);
  return new BotCheckError(`Cloudflare's bot check failed (error ${code || 'unknown'}${hint ? `: ${hint}` : ''}). Try again.`);
}

/** Shows the bot check over the page and resolves with its token. */
export async function captchaToken(note = 'Quick check before your first online game.'): Promise<string> {
  const ts = await load();
  const box = document.createElement('div');
  box.className = 'captcha-overlay';
  box.innerHTML = '<div class="panel"><p class="note center"></p><div class="captcha-slot"></div><button class="btn ghost" type="button">Cancel</button></div>';
  box.querySelector('p')!.textContent = note;
  document.body.append(box);
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let id = '';
      const stop = (err: BotCheckError) => { if (id) ts.remove(id); reject(err); };
      giveUp = setTimeout(() => stop(new BotCheckError("The bot check timed out. Try again.")), CHECK_TIMEOUT_MS);
      box.querySelector('button')!.addEventListener('click', () => stop(new BotCheckError('The bot check was cancelled. Try again when you are ready.')));
      id = ts.render(box.querySelector<HTMLElement>('.captcha-slot')!, {
        sitekey: SITE_KEY!, theme: 'dark',
        callback: (token) => { ts.remove(id); resolve(token); },
        'error-callback': (code) => { stop(turnstileError(code)); },
        'timeout-callback': () => stop(new BotCheckError('The bot check timed out. Try again.')),
        'expired-callback': () => stop(new BotCheckError('The bot check expired. Try again.')),
        'unsupported-callback': () => stop(new BotCheckError("This browser can't run the bot check. Try another browser.")),
      });
    });
  } finally {
    clearTimeout(giveUp);
    box.remove();
  }
}
