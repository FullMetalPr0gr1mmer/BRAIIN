"""Tighter Almarai subsets for the Arabic routes (docs/fonts.md, CLAUDE.md §6).

WHY: Lighthouse's simulated LCP treats web-font requests as render-blocking, and /ar loads
every Almarai face it lays out text in — 400/700/800 x {arabic, latin} — so the Arabic
home page first-painted ~0.8 s after the English one and missed the LCP and performance
budgets (found the day perf-seo-a11y first ran as a PR gate, 2026-09-25). The fix is
bytes, not tricks:

  arabic faces  U+0600-06FF (the Arabic block — letters, harakat, Arabic-Indic digits,
                ، ؛ ؟ ـ) plus space/nbsp and the joiners. Arabic Supplement / Extended-A/B
                and the presentation-form CODE POINTS are dropped. Contextual (init / medi
                / fina) and ligature glyphs (lam-alef) are KEPT: the subsetter follows the
                GSUB closure of the kept characters, so shaping is unchanged.
  latin faces   an ASCII core plus the marks the copy actually uses (© « » · × – — ‘ ’
                “ ” • … € ™ arrows −). On the Arabic routes Latin only appears in digits,
                emails, and a few names; Latin-1 letters fall back to 'Almarai Fallback'.

scripts/…/scan-chars (see docs/fonts.md) confirmed every visible code point on every
public AR route is covered by the union of the two.

Idempotent: subsetting an already-subset file with the same ranges reproduces it, so the
script can be re-run over public/fonts. To start from Google-hosted originals instead,
pass --src <dir> holding almarai-{400,700,800}-{arabic,latin}.woff2 (or .ttf).

  python scripts/subset-fonts.py [--src DIR]   (needs: pip install fonttools brotli)
"""

import argparse
import io
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'fonts')

# Shaping features to keep. Anything Arabic text needs to join and ligate correctly.
FEATURES = [
    'init', 'medi', 'fina', 'isol', 'rlig', 'liga', 'calt', 'ccmp', 'locl',
    'mark', 'mkmk', 'kern', 'curs', 'rclt',
]


def rng(a, b):
    return list(range(a, b + 1))


# Keep these in lock-step with the unicode-range descriptors in public/styles/global.css.
ARABIC = [0x20, 0xA0] + rng(0x0600, 0x06FF) + rng(0x200C, 0x200E) + [0x2010, 0x2011]
LATIN = (
    rng(0x20, 0x7E)
    + [0xA0, 0xA9, 0xAB, 0xB7, 0xBB, 0xD7]
    + rng(0x2013, 0x2014)
    + rng(0x2018, 0x201D)
    + [0x2022, 0x2026, 0x20AC, 0x2122]
    + rng(0x2190, 0x2193)
    + [0x2212]
)


def subset_file(src, dst, unicodes):
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = FEATURES
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    opts.glyph_names = False
    font = TTFont(src)
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    buf = io.BytesIO()
    font.flavor = 'woff2'
    font.save(buf)
    with open(dst, 'wb') as f:  # write after the full encode, so a failure leaves the old file
        f.write(buf.getvalue())
    return len(buf.getvalue())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=OUT, help='directory with the source faces (default: public/fonts)')
    args = ap.parse_args()
    total = 0
    for weight in (400, 700, 800):
        for script, codepoints in (('arabic', ARABIC), ('latin', LATIN)):
            name = f'almarai-{weight}-{script}.woff2'
            src = os.path.join(args.src, name)
            if not os.path.exists(src):
                ttf = src[: -len('.woff2')] + '.ttf'
                if not os.path.exists(ttf):
                    sys.exit(f'missing source face: {src}')
                src = ttf
            size = subset_file(src, os.path.join(OUT, name), codepoints)
            total += size
            print(f'  {name:28} {size:6} B')
    print(f'  Almarai total (a route loading every face): {total} B')


if __name__ == '__main__':
    main()
