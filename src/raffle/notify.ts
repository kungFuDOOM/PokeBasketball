// Hands a finished game to the weekly-challenge client. The import stays inside the function so a local game
// does not download the online client until a game actually ends.

import type { OfflineMode } from '../telemetry/offlineStats';
import { creditsOffline } from './entries';

export function notePlayedOffline(mode: OfflineMode, resolution: string): void {
  if (!creditsOffline(resolution)) return;
  void import('./client').then((m) => m.noteOfflinePlayed(mode));
}

export function noteShared(): void {
  void import('./client').then((m) => m.noteShare());
}

export function warmWeekly(): void {
  void import('./client').then((m) => m.warmChallenges());
}
