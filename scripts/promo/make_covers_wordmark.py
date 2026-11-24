"""Wordmark-only TapTap covers (no separate icon in the lockup)."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "promo"))
import make_promos as mp  # noqa: E402
import make_keyart_scene as ks  # noqa: E402

RAW = Image.open(ROOT / "deliverables" / "screenshots" / "14-level-19-three-cities-4k.png").convert("RGB")
LOGO_H = ROOT / "deliverables" / "logo" / "logo-horizontal-1280.png"
LOGO_S = ROOT / "deliverables" / "logo" / "logo-stacked-720.png"
OUT = ROOT / "deliverables" / "covers"
TAP = ROOT / "deliverables" / "taptap"
CYAN = (150, 220, 232)


def logo(path: Path, width: int) -> Image.Image:
    im = Image.open(path).convert("RGBA")
    im = im.crop(im.getbbox())
    h = round(width * im.height / im.width)
    return im.resize((width, h), Image.Resampling.LANCZOS)


def map_img(crop, size):
    img = RAW.crop(crop).resize(size, Image.Resampling.LANCZOS)
    img = ks.grade(img)
    img = ks.bloom(img, 118, 18)
    return img


def make_landscape(mode="stacked"):
    W, H = 1840, 860
    base = RAW.crop((1200, 500, 3040, 1560)).resize((W, H), Image.Resampling.LANCZOS)
    base = base.filter(ImageFilter.GaussianBlur(40))
    base = ImageEnhance.Brightness(base).enhance(0.38)
    base = ImageEnhance.Color(base).enhance(1.3).convert("RGBA")
    shot = map_img((1680, 650, 2900, 1510), (1220, 860))
    base.paste(shot, (620, 0))

    panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    for x in range(0, 700):
        t = x / 700
        a = int(246 * (1 - t) ** 1.55)
        pd.line([(x, 0), (x, H)], fill=(4, 12, 18, a))
    base = Image.alpha_composite(base, panel)

    seam = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(seam)
    sd.line([(642, 0), (642, H)], fill=(*CYAN, 92), width=2)
    seam = seam.filter(ImageFilter.GaussianBlur(3))
    base.alpha_composite(seam)

    rings = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rings)
    for r in (300, 440, 580):
        rd.arc([-120 - r, 620 - r, -120 + r, 620 + r], 0, 360,
               fill=(*CYAN, 13), width=2)
    base.alpha_composite(rings)

    if mode == "stacked":
        lg = logo(LOGO_S, 450)
        base.alpha_composite(lg, ((642 - lg.width) // 2, (H - lg.height) // 2))
    else:
        lg = logo(LOGO_H, 520)
        base.alpha_composite(lg, (58, (H - lg.height) // 2))

    ks.rain(base, 80)
    base = mp.vignette(base.convert("RGB"))
    for w, h, name in ((1840, 860, "landscape-1840x860"), (920, 430, "landscape-920x430"),
                       (460, 215, "landscape-460x215")):
        im = base.resize((w, h), Image.Resampling.LANCZOS)
        im.save(OUT / f"{name}.jpg", quality=96, subsampling=1)
        im.save(OUT / f"{name}.png", optimize=True)
        im.save(TAP / f"cover-{name}.jpg", quality=96, subsampling=1)
        im.save(TAP / f"cover-{name}.png", optimize=True)


def make_portrait():
    W, H = 1200, 1800
    base = RAW.crop((1200, 500, 3040, 2060)).resize((W, H), Image.Resampling.LANCZOS)
    base = base.filter(ImageFilter.GaussianBlur(40))
    base = ImageEnhance.Brightness(base).enhance(0.38)
    base = ImageEnhance.Color(base).enhance(1.3).convert("RGBA")
    shot = map_img((1680, 800, 2880, 2040), (1200, 1240))
    base.paste(shot, (0, 560))

    panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    for y in range(0, 620):
        t = y / 620
        a = int(246 * (1 - t) ** 1.5)
        pd.line([(0, y), (W, y)], fill=(4, 12, 18, a))
    base = Image.alpha_composite(base, panel)

    seam = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(seam)
    sd.line([(0, 570), (W, 570)], fill=(*CYAN, 88), width=2)
    seam = seam.filter(ImageFilter.GaussianBlur(3))
    base.alpha_composite(seam)

    rings = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rings)
    for r in (280, 420, 560):
        rd.ellipse([W // 2 - r, 250 - r, W // 2 + r, 250 + r],
                   outline=(*CYAN, 12), width=2)
    base.alpha_composite(rings)

    lg = logo(LOGO_H, 900)
    base.alpha_composite(lg, ((W - lg.width) // 2, 132))

    ks.rain(base, 80)
    base = mp.vignette(base.convert("RGB"))
    for w, h, name in ((1200, 1800, "portrait-1200x1800"), (600, 900, "portrait-600x900")):
        im = base.resize((w, h), Image.Resampling.LANCZOS)
        im.save(OUT / f"{name}.jpg", quality=96, subsampling=1)
        im.save(OUT / f"{name}.png", optimize=True)
        im.save(TAP / f"cover-{name}.jpg", quality=96, subsampling=1)
        im.save(TAP / f"cover-{name}.png", optimize=True)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["stacked", "horizontal"], default="stacked")
    args = ap.parse_args()
    make_landscape(args.mode)
    make_portrait()
    print("wrote covers with", args.mode)
