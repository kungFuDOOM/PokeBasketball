// Original gold pixel crown drawn over the Kabuto sprite in code (public/sprites is gitignored, so no baked PNG).

/** TODO(T3): hand-drawn pixel rows, '.' empty, 'g' gold, 'd' dark gold shade, 'h' highlight. */
export const CROWN_PIXELS: readonly string[] = [];

/** TODO(T3): draw the crown on a sprite canvas (nearest-neighbour, scaled to the sprite). No-op for now. */
export function drawCrown(_ctx: CanvasRenderingContext2D, _w: number, _h: number): void {}

/** TODO(T3): resolves to a data URL of Kabuto's sprite with the crown on it. */
export async function crownedSpriteUrl(_spriteUrl: string): Promise<string> {
  return _spriteUrl;
}
