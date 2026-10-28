import type { Audio } from '../../game/audio';
import type { Settings } from '../../screens/menu';

/** What every mode screen receives from the hub. */
export interface ModeContext {
  root: HTMLElement;
  settings: Settings;
  audio: Audio;
  /** Back to the multiplayer hub. */
  back(): void;
}
