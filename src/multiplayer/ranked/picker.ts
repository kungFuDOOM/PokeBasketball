// The username picker screen logic: checks the rules on the client for fast feedback, then asks the server (which has the
// final say, including uniqueness). Text only: errors and the typed value go through view.ts, which escapes them.
import { checkUsername, nameErrorText } from './username';
import { usernamePickerHtml } from './view';

export interface NameSetter { setUsername(name: string): Promise<string> }

export function mountUsernamePicker(slot: HTMLElement, svc: NameSetter, o: { initial?: string; note?: string; onDone(name: string): void; onCancel?(): void }) {
  const render = (value: string, error: string | null = null, busy = false) => {
    slot.innerHTML = usernamePickerHtml({ value, error, busy, note: o.note })
      + (o.onCancel ? '<div class="actions center"><button class="btn ghost" type="button" data-a="un-cancel">Cancel</button></div>' : '');
    slot.querySelector('[data-a="un-cancel"]')?.addEventListener('click', () => o.onCancel?.());
    const form = slot.querySelector<HTMLFormElement>('form')!;
    const input = form.querySelector<HTMLInputElement>('input')!;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = input.value;
      const bad = checkUsername(v);
      if (bad) return render(v, nameErrorText(bad));
      render(v, null, true);
      try {
        o.onDone(await svc.setUsername(v));
      } catch (err) {
        render(v, err instanceof Error && err.message ? err.message : 'Could not save your username. Try again.');
      }
    });
  };
  render(o.initial ?? '');
}
