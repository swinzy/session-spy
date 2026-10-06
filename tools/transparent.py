#!/usr/bin/env python3
"""Makes a screenshot's desktop transparent, keeping menu shadows.

Usage: tools/transparent.py <on-white.png> <on-black.png> <out.png>

Takes the same screenshot taken on a plain white and a plain black desktop
(tests/run.sh with SS_BACKGROUND=#ffffff and #000000) and works out each
pixel's opacity from how much the background shows through: opaque pixels
look the same on both, the desktop differs fully, and shadows in between.
The result is cropped to the top bar above the menu and the menu with its
shadow. Needs Pillow.
"""
import sys

from PIL import Image


def main(white_path, black_path, out_path):
    white = Image.open(white_path).convert("RGB")
    black = Image.open(black_path).convert("RGB")
    if white.size != black.size:
        sys.exit("the screenshots differ in size")
    width, height = white.size

    out = Image.new("RGBA", white.size)
    wp, bp, op = white.load(), black.load(), out.load()
    for y in range(height):
        for x in range(width):
            w, b = wp[x, y], bp[x, y]
            # What shows through of the background, averaged over the channels
            alpha = 255 - round(sum(wc - bc for wc, bc in zip(w, b)) / 3)
            alpha = max(0, min(255, alpha))
            if alpha == 0:
                op[x, y] = (0, 0, 0, 0)
            else:
                # On black, a pixel is its own colour times its opacity
                op[x, y] = tuple(min(255, round(c * 255 / alpha)) for c in b) + (alpha,)

    # The top bar is opaque across the whole width (judged at its left end:
    # the clock in the middle may have changed between the screenshots);
    # below it, crop to what is not fully transparent (the menu and its
    # shadow), up to the right edge
    alpha = out.getchannel("A")
    bar = next(y for y in range(height) if alpha.getpixel((0, y)) < 255)
    left, _, _, bottom = alpha.crop((0, bar, width, height)).getbbox()
    out.crop((left, 0, width, bar + bottom)).save(out_path)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__.strip().splitlines()[2])
    main(*sys.argv[1:])
