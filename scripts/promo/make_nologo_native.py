"""Native, text-free TapTap no-logo promo pair + library wallpaper."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageEnhance

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "promo"))
import make_editorial_covers as ed  # noqa: E402

SRC = ROOT / "capture" / "library" / "canvas-clean-4k.png"
OUT = ROOT / "deliverables" / "taptap"


def render(crop, size, seed):
    im = Image.open(SRC).convert("RGB").crop(crop)
    im = im.resize(size, Image.Resampling.LANCZOS)
    im = ed.grade(im)
    im = ed.atmosphere(im, seed)
    im = ImageEnhance.Contrast(im).enhance(1.04)
    im = ImageEnhance.Color(im).enhance(1.04)
    return im.convert("RGB")


def main():
    landscape = render((0, 400, 3940, 2616), (1920, 1080), 51)
    landscape.save(OUT / "no-logo-landscape-1920x1080.jpg", quality=95, subsampling=1)
    landscape.save(OUT / "no-logo-landscape-1920x1080.png", optimize=True)

    portrait = render((650, 120, 2270, 2550), (1080, 1620), 52)
    portrait.save(OUT / "no-logo-portrait-1080x1620.jpg", quality=95, subsampling=1)
    portrait.save(OUT / "no-logo-portrait-1080x1620.png", optimize=True)

    library = render((50, 350, 3890, 1590), (3840, 1240), 53)
    library.save(OUT / "library-background-3840x1240.jpg", quality=95, subsampling=1)
    library.save(OUT / "library-background-3840x1240.png", optimize=True)

    print("wrote no-logo pair + library background", landscape.size, portrait.size, library.size)


if __name__ == "__main__":
    main()

