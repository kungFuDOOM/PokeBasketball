// Remembers whether the player has finished (or skipped) the tutorial. Local only.
// The `pokejam.` prefix means the existing "Delete saved data" button clears it too.
export const TUTORIAL_DONE_KEY = 'pokejam.tutorialDone';

export function isTutorialDone(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_DONE_KEY) === '1';
  } catch {
    return false; // storage blocked or unavailable: treat as not done
  }
}

export function markTutorialDone(): void {
  try {
    localStorage.setItem(TUTORIAL_DONE_KEY, '1');
  } catch {
    // storage blocked or full: nothing to persist, ignore
  }
}
