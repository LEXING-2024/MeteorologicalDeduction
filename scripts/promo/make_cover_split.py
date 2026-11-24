"""Split-layout covers: clean logo field + native gameplay map."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "promo"))
import make_promos as mp  # noqa: E402
import make_keyart_scene as ks  # noqa: E402

RAW = Image.open(ROOT / "deliverables" / "screenshots" / "14-level-19-three-cities-4k.png").convert("RGB")
OUT = ROOT / "deliverables" / "cover-split"
OUT.mkdir(parents=True, exist_ok=True)
ICON = Image.open(ROOT / "deliverables" / "icon" / "icon-512.png").convert("RGB")
CYAN = (150, 220, 232)


def map_img(crop, size):
    img = RAW.crop(crop).resize(size, Image.Resampling.LANCZOS)
    img = ks.grade(img)
    img = ks.bloom(img, 118, 18)
    return img


def icon(img, xy, s):
    img.paste(ICON.resize((s, s), Image.Resampling.LANCZOS), xy)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([xy[0] - 1, xy[1] - 1, xy[0] + s, xy[1] + s], radius=max(8, s // 12),
                        outline=(*CYAN, 115), width=max(1, s // 90))


def make_landscape():
    W, H = 1840, 860
    base = RAW.crop((1200, 500, 3040, 1560)).resize((W, H), Image.Resampling.LANCZOS)
    base = base.filter(ImageFilter.GaussianBlur(40))
    base = ImageEnhance.Brightness(base).enhance(0.40)
    base = ImageEnhance.Color(base).enhance(1.3).convert("RGBA")
    shot = map_img((1680, 650, 2900, 1510), (1220, 860))
    base.paste(shot, (620, 0))

    # soft dark panel for the title
    panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    for x in range(0, 700):
        t = x / 700
        a = int(238 * (1 - t) ** 1.7)
        pd.line([(x, 0), (x, H)], fill=(4, 12, 18, a))
    base = Image.alpha_composite(base.convert("RGBA"), panel)

    # seam light
    seam = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(seam)
    sd.line([(642, 0), (642, H)], fill=(*CYAN, 100), width=2)
    seam = seam.filter(ImageFilter.GaussianBlur(3))
    base.alpha_composite(seam)

    rings = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rings)
    for r in (280, 420, 560, 700):
        rd.arc([-120 - r, 620 - r, -120 + r, 620 + r], 0, 360,
               fill=(*CYAN, 14), width=2)
    base.alpha_composite(rings)

    s = 112
    icon(base, (70, 178), s)
    ks.draw_title(base, (70, 320), 114, 8)
    d = ImageDraw.Draw(base)
    d.line([(72, 284), (212, 284)], fill=(*CYAN, 160), width=2)
    d.polygon([(72, 278), (82, 284), (72, 290)], fill=(*CYAN, 160))

    ks.rain(base, 80)
    base = mp.vignette(base.convert("RGB"))
    base.convert("RGB").save(OUT / "cover-landscape-1840x860.jpg", quality=96, subsampling=1)
    base.convert("RGB").save(OUT / "cover-landscape-1840x860.png", optimize=True)
    for w, h, name in ((920, 430, "cover-landscape-920x430"), (460, 215, "cover-landscape-460x215")):
        base.convert("RGB").resize((w, h), Image.Resampling.LANCZOS).save(OUT / f"{name}.jpg", quality=96, subsampling=1)
        base.convert("RGB").resize((w, h), Image.Resampling.LANCZOS).save(OUT / f"{name}.png", optimize=True)


def make_portrait():
    W, H = 1200, 1800
    base = RAW.crop((1200, 500, 3040, 2060)).resize((W, H), Image.Resampling.LANCZOS)
    base = base.filter(ImageFilter.GaussianBlur(40))
    base = ImageEnhance.Brightness(base).enhance(0.40)
    base = ImageEnhance.Color(base).enhance(1.3).convert("RGBA")
    shot = map_img((1680, 800, 2880, 2040), (1200, 1240))
    base.paste(shot, (0, 560))

    panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    for y in range(0, 640):
        t = y / 640
        a = int(240 * (1 - t) ** 1.6)
        pd.line([(0, y), (W, y)], fill=(4, 12, 18, a))
    base = Image.alpha_composite(base.convert("RGBA"), panel)

    seam = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(seam)
    sd.line([(0, 570), (W, 570)], fill=(*CYAN, 90), width=2)
    seam = seam.filter(ImageFilter.GaussianBlur(3))
    base.alpha_composite(seam)

    rings = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rings)
    for r in (260, 400, 540):
        rd.ellipse([W // 2 - r, 260 - r, W // 2 + r, 260 + r],
                   outline=(*CYAN, 12), width=2)
    base.alpha_composite(rings)

    s = 140
    icon(base, ((W - s) // 2, 72), s)
    ks.draw_title(base, (348, 246), 118, 8)
    d = ImageDraw.Draw(base)
    d.line([(W // 2 - 110, 416), (W // 2 + 110, 416)], fill=(*CYAN, 80), width=1)

    ks.rain(base, 80)
    base = mp.vignette(base.convert("RGB"))
    base.convert("RGB").save(OUT / "cover-portrait-1200x1800.jpg", quality=96, subsampling=1)
    base.convert("RGB").save(OUT / "cover-portrait-1200x1800.png", optimize=True)
    base.convert("RGB").resize((600, 900), Image.Resampling.LANCZOS).save(OUT / "cover-portrait-600x900.jpg", quality=96, subsampling=1)
    base.convert("RGB").resize((600, 900), Image.Resampling.LANCZOS).save(OUT / "cover-portrait-600x900.png", optimize=True)


if __name__ == "__main__":
    make_landscape()
    make_portrait()
    print("wrote", OUT)
