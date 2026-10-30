// What the profile screen reads from the server and how its buttons work. Loaded on demand by src/screens/profile.ts, so
// the Supabase client and the Ranked code stay out of the main menu's chunk. Nothing here reads or shows an email or a
// wallet address: only the username, rank and win/loss counts.
import { MODE_RANKED, MODE_SOCIAL } from '../../config/features';
import type { ProfileModel } from '../../screens/profile';
import { supabase } from '../shared/supabase';
import { isGuest } from './account';
import { mountUsernamePicker } from './picker';

/** Social matches I played and won (the server lets me read only my own match rows). Null when there is nothing to count. */
async function socialRecord(uid: string): Promise<ProfileModel['social']> {
  try {
    const sb = supabase();
    const done = () => sb.from('pokejam_matches').select('id', { count: 'exact', head: true }).eq('queue', 'social').eq('status', 'done');
    const [played, won] = await Promise.all([done(), done().eq('winner', uid)]);
    if (played.error || won.error || !played.count) return null;
    return { played: played.count, won: won.count ?? 0 };
  } catch {
    return null;
  }
}

/** Fills in the online parts of the profile. Never creates a guest session: a visitor with none just sees their local stats. */
export async function loadProfileModel(base: ProfileModel): Promise<ProfileModel> {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  const user = data.session?.user;
  const model: ProfileModel = { ...base, onlineAvailable: true };
  if (!user) return model;
  model.signedIn = !isGuest(user);
  if (MODE_SOCIAL) model.social = await socialRecord(user.id);
  if (MODE_RANKED && model.signedIn) {
    const { rankedAccount } = await import('./index');
    const svc = await rankedAccount();
    const [un, me] = await Promise.all([svc.myUsername().catch(() => null), svc.rankedMe().catch(() => null)]);
    model.username = un?.username ?? null;
    model.nextChangeAt = un?.nextChangeAt ?? null;
    model.me = me;
  }
  return model;
}

/** Buttons on the profile: change the username, or sign in (guests). */
export function wireProfile(root: HTMLElement, model: ProfileModel, _ctx: { back(): void }, _redraw: () => void, reopen: () => void) {
  if (!MODE_RANKED) return; // the buttons below only exist in a Ranked build
  root.querySelector('[data-a="rename"]')?.addEventListener('click', async () => {
    const slot = root.querySelector<HTMLElement>('.pf-left');
    if (!slot) return;
    const { rankedAccount } = await import('./index');
    const svc = await rankedAccount();
    mountUsernamePicker(slot, svc, {
      initial: model.username ?? '',
      note: model.nextChangeAt ? `You can change your name again on ${new Date(model.nextChangeAt).toLocaleDateString()}.` : undefined,
      onDone: reopen,
      onCancel: reopen,
    });
  });
  const signIn = root.querySelector<HTMLElement>('[data-signin]');
  if (signIn) {
    void import('./index').then(({ mountSignIn }) => mountSignIn(signIn, { returnTo: 'profile', onSignedIn: reopen }));
  }
}
