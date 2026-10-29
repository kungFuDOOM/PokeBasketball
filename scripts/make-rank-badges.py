#!/usr/bin/env python3
"""Build the ranked tier badge PNGs (public/ranks/<tier>.png at 128px, <tier>@2x.png at 256px) from the 1024px source art
(badge on a dark navy background). Usage: python3 scripts/make-rank-badges.py [SRC_DIR]   (default /workspace/pj-badge-src)

The background is removed by flood fill from the image edges only, so dark pixels inside a badge (silver, gold star centre,
eclipse outline) stay opaque. Alpha is binary (hard pixel-art edge): the flooded region is transparent, then the opaque edge is
eroded 1px to drop the soft glow rim. The background test is navy-ish (not just dark), so black outlines are walls. Needs numpy, scipy and Pillow.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'prism', 'eclipse', 'master', 'zenith']
TOL = 18        # core background: max RGB distance from the corner colour (tight, so black outlines are walls)
HUE = 6         # ...and the pixel must be navy-ish: blue at least this far above red, like the background
FRINGE = 4      # then up to this many px of dim, bluish glow next to the background are removed too
FRINGE_MAX_LUM = 70
PAD = 0.04  # padding around the content bbox, as a fraction of its size
OUT = Path(__file__).resolve().parent.parent / 'public' / 'ranks'


def flood_bg(rgb: np.ndarray, tol: float) -> np.ndarray:
    """Background connected to the image border. The core is navy-ish AND near the corner colour (a black outline is neither,
    so it stops the fill); then a few px of dim bluish glow touching it are added, never crossing a non-bluish pixel."""
    h, w, _ = rgb.shape
    k = 12
    corners = np.concatenate([rgb[:k, :k].reshape(-1, 3), rgb[:k, -k:].reshape(-1, 3), rgb[-k:, :k].reshape(-1, 3), rgb[-k:, -k:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    f = rgb.astype(np.float32)
    bluish = (f[..., 2] - f[..., 0] >= HUE) & (f[..., 2] >= f[..., 1])
    near = (np.linalg.norm(f - bg, axis=2) <= tol) & bluish
    lab, _ = ndimage.label(near)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    seen = np.isin(lab, edge[edge > 0])
    glow = bluish & (f.mean(axis=2) <= FRINGE_MAX_LUM)
    for _ in range(FRINGE):
        seen = seen | (ndimage.binary_dilation(seen) & glow)
    return seen


def erode(mask: np.ndarray) -> np.ndarray:
    m = mask.copy()
    m[1:] &= mask[:-1]
    m[:-1] &= mask[1:]
    m[:, 1:] &= mask[:, :-1]
    m[:, :-1] &= mask[:, 1:]
    return m


def keep_main(mask: np.ndarray) -> np.ndarray:
    """Drop stray specks (JPEG noise); keep every component of real size (a badge can be several pieces)."""
    lab, n = ndimage.label(mask)
    if n <= 1:
        return mask
    sizes = np.asarray(ndimage.sum(mask, lab, range(1, n + 1)))
    return np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= 0.003 * mask.size or s == sizes.max()])


def process(src: Path, sizes: tuple) -> list:
    rgb = np.array(Image.open(src).convert('RGB'))
    opaque = keep_main(erode(~flood_bg(rgb, TOL)))
    ys, xs = np.where(opaque)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    side = int(max(y1 - y0, x1 - x0) * (1 + 2 * PAD))
    cy, cx = (y0 + y1) // 2, (x0 + x1) // 2
    box = (cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side)
    # Fill transparent pixels with the badge's mean colour so BOX resizing does not pull navy into the edge.
    fill = tuple(int(c) for c in rgb[opaque].mean(axis=0))
    col = Image.fromarray(np.where(opaque[..., None], rgb, np.array(fill, np.uint8)), 'RGB').crop(box)
    alpha = Image.fromarray((opaque * 255).astype(np.uint8), 'L').crop(box)
    res = []
    for s in sizes:
        a = alpha.resize((s, s), Image.BOX).point(lambda v: 255 if v >= 128 else 0)
        c = col.resize((s, s), Image.BOX).convert('RGBA')
        c.putalpha(a)
        res.append(c)
    return res


def save(img: Image.Image, path: Path):
    """255-colour palette plus one transparent index: far smaller than RGBA and keeps the flat pixel-art colours."""
    q = img.convert('RGB').quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal = (q.getpalette() or [])[:765]
    pal += [0] * (765 - len(pal)) + [0, 0, 0]
    idx = np.array(q)
    idx[np.array(img.getchannel('A')) < 128] = 255
    p = Image.fromarray(idx, 'P')
    p.putpalette(pal)
    p.save(path, optimize=True, transparency=255)


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else '/workspace/pj-badge-src')
    OUT.mkdir(parents=True, exist_ok=True)
    for t in TIERS:
        one, two = process(src / f'{t}.jpg', (128, 256))
        save(one, OUT / f'{t}.png')
        save(two, OUT / f'{t}@2x.png')
        al = np.array(one.getchannel('A')) > 0
        yy, xx = np.mgrid[:128, :128]
        disc = al[(yy - 63.5) ** 2 + (xx - 63.5) ** 2 <= 20 ** 2].mean()  # the basketball: must be solid
        opaque = al.mean()
        print(f'{t:9} centre {disc:.0%} opaque {opaque:.0%}  {(OUT / f"{t}.png").stat().st_size} B / {(OUT / f"{t}@2x.png").stat().st_size} B')


if __name__ == '__main__':
    main()
