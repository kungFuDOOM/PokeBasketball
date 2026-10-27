// Pack Battles: placeholder only. Owned by thepaypay420 (see pokejam-test issue 4).
import { panel } from '../shared/matchFlow';
import type { ModeContext } from '../shared/types';

export function openPackBattles(ctx: ModeContext) {
  ctx.root.className = 'screen-menu';
  ctx.root.innerHTML = panel('PACK BATTLES', 'Coming soon: Pack Battles',
    `<div class="actions center"><button class="btn primary big" data-a="back">Back</button></div>`);
  ctx.root.querySelector('[data-a="back"]')!.addEventListener('click', ctx.back);
}
