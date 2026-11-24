"""3840x1240 TapTap library wallpaper: native weather chart, no text."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "promo"))
import make_editorial_covers as ed  # noqa: E402

SRC = ROOT / "capture" / "library" / "wallpaper-crop.jpg"
OUT = ROOT / "deliverables" / "taptap"


def main():
    im = Image.open(SRC).convert("RGB")
    im = ed.grade(im)
    im = ed.atmosphere(im, 44)
    # A little extra depth at the edges without introducing any text.
    im = ImageEnhance.Contrast(im).enhance(1.04)
    im = ImageEnhance.Color(im).enhance(1.05)
    im.convert("RGB").save(OUT / "library-background-3840x1240.jpg", quality=95, subsampling=1)
    im.convert("RGB").save(OUT / "library-background-3840x1240.png", optimize=True)
    print("wrote", OUT / "library-background-3840x1240.jpg", im.size)


if __name__ == "__main__":
    main()
