"""Hybrid key art set: blurred native map colour + crisp vector graphics."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "promo"))
import make_promos as mp  # noqa: E402
import make_taptap_rich as rich  # noqa: E402
import make_keyart_scene as ks  # noqa: E402

RAW = Image.open(ROOT / "deliverables" / "screenshots" / "14-level-19-three-cities-4k.png").convert("RGB")
OUT = ROOT / "deliverables" / "hybrid-set"
OUT.mkdir(parents=True, exist_ok=True)
ICON = Image.open(ROOT / "deliverables" / "icon" / "icon-512.png").convert("RGB")
CYAN = rich.CYAN


def left_field(w, h, clear=1450, alpha=245, solid=0):
    import numpy as np
    yy, xx = np.mgrid[0:h, 0:w]
    t = np.clip((xx - solid) / max(1, clear - solid), 0, 1)
    t = t * t * (3 - 2 * t)
    a = (alpha * (1 - t)).astype(np.uint8)
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 3] = a
    return Image.fromarray(arr, "RGBA")


def top_field(w, h, clear=620, alpha=246, solid=0):
    import numpy as np
    yy, xx = np.mgrid[0:h, 0:w]
    t = np.clip((yy - solid) / max(1, clear - solid), 0, 1)
    t = t * t * (3 - 2 * t)
    a = (alpha * (1 - t)).astype(np.uint8)
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 3] = a
    return Image.fromarray(arr, "RGBA")


def build(W: int, H: int, side: str) -> Image.Image:
    ss = 2
    w, h = W * ss, H * ss
    u = min(w, h)
    s = u / 1080.0

    base = RAW.crop((850, 330, 3150, 1623)).resize((w, h), Image.Resampling.LANCZOS)
    base = base.filter(ImageFilter.GaussianBlur(42))
    base = ImageEnhance.Brightness(base).enhance(1.45)
    base = ImageEnhance.Color(base).enhance(1.45)
    base = ImageEnhance.Contrast(base).enhance(1.10)
    base = Image.alpha_composite(base.convert("RGBA"), Image.new("RGBA", (w, h), (4, 12, 18, 112)))

    low = (0.352 * w, 0.410 * h)
    high = (0.696 * w, 0.657 * h)

    art = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(art)

    for i, r in enumerate((70, 118, 168, 220, 272)):
        rich.isobar(d, high[0], high[1], r * s, 0.9 + i * 0.5, rich.AMBER,
                    78 if i < 3 else 55, max(2, round((2 if i < 2 else 1.4) * s)))
    rich.pressure_center(d, high[0], high[1], "H", rich.AMBER, scale=0.92 * s, letters=False)

    for i, r in enumerate((96, 148, 202, 258, 316, 376, 438, 502, 568)):
        rich.isobar(d, low[0], low[1], r * s, 0.35 + i * 0.42, rich.CYAN,
                    165 if i < 4 else 125, max(2, round((3 if i < 2 else 2.2) * s)))
    rich.pressure_center(d, low[0], low[1], "L", (135, 225, 210), scale=1.05 * s, letters=False)

    rich.wind_field(d, w, h, low, high, step=max(48, round(u / 18)), scale=u * 0.34)

    cold = [(low[0] - 16, low[1] + 18), (low[0] - u * 0.10, low[1] + u * 0.14),
            (low[0] - u * 0.22, low[1] + u * 0.28), (low[0] - u * 0.36, low[1] + u * 0.42),
            (low[0] - u * 0.50, low[1] + u * 0.56)]
    rich.cold_front(d, cold, side=-1, width=max(3, round(u / 330)), size=u * 0.022)
    warm = [(low[0] + 22, low[1] + 8), (low[0] + u * 0.10, low[1] + u * 0.075),
            (low[0] + u * 0.21, low[1] + u * 0.115), (low[0] + u * 0.33, low[1] + u * 0.12),
            (low[0] + u * 0.43, low[1] + u * 0.09)]
    rich.warm_front(d, warm, side=-1, width=max(3, round(u / 350)), size=u * 0.017)

    rich.city_node(d, low[0], low[1], s=u / 1500)
    rich.city_node(d, high[0], high[1], s=u / 1650)
    rich.city_node(d, low[0] + u * 0.18, low[1] + u * 0.32, s=u / 1750)

    base = Image.alpha_composite(base, art)
    base = Image.alpha_composite(base, ks.radial_glow((w, h), low[0], low[1], u * 0.30, u * 0.26, (55, 180, 165), 55))
    base = Image.alpha_composite(base, ks.radial_glow((w, h), high[0], high[1], u * 0.18, u * 0.16, (210, 145, 70), 38))

    if side == "left":
        base = Image.alpha_composite(base, left_field(w, h, w * 0.38, 245, 0))
    else:
        base = Image.alpha_composite(base, top_field(w, h, h * 0.34, 248, 0))

    base = base.convert("RGB").resize((W, H), Image.Resampling.LANCZOS)
    base = base.convert("RGBA")
    ks.rain(base, 120)
    base = base.convert("RGB")
    base = mp.vignette(base)
    base = ImageEnhance.Brightness(base).enhance(0.98)
    return base.convert("RGBA")


def icon(img, xy, s):
    img.paste(ICON.resize((s, s), Image.Resampling.LANCZOS), xy)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([xy[0] - 1, xy[1] - 1, xy[0] + s, xy[1] + s], radius=max(8, s // 12),
                        outline=(*CYAN, 115), width=max(1, s // 90))


def make_promo():
    W, H = 1920, 1080
    img = build(W, H, "left")

    # interaction cue at the low-pressure cell
    ring = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    rx, ry, rr = 676, 443, 78
    for i in range(28):
        if i % 2 == 0:
            a0 = i * 360 / 28
            rd.arc([rx - rr, ry - rr, rx + rr, ry + rr], a0, a0 + 8,
                   fill=(*CYAN, 120), width=2)
    img.alpha_composite(ring.filter(ImageFilter.GaussianBlur(2)))

    cur = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(cur)
    cx, cy = 726, 500
    pts = [(cx, cy), (cx + 2, cy + 42), (cx + 11, cy + 33), (cx + 19, cy + 51),
           (cx + 29, cy + 47), (cx + 21, cy + 29), (cx + 34, cy + 27)]
    cd.polygon(pts, fill=(245, 253, 255, 245), outline=(6, 18, 24, 240))
    cd.line([(cx + 2, cy + 4), (cx + 11, cy + 13)], fill=(*CYAN, 230), width=2)
    img.alpha_composite(cur.filter(ImageFilter.GaussianBlur(10)))
    img.alpha_composite(cur)

    ks.draw_title(img, (120, 790), 124, 10)
    d = ImageDraw.Draw(img)
    d.line([(120, 744), (270, 744)], fill=(*CYAN, 170), width=2)
    d.polygon([(120, 738), (130, 744), (120, 750)], fill=(*CYAN, 170))
    d.line([(122, 936), (600, 936)], fill=(*CYAN, 80), width=1)
    img.convert("RGB").save(OUT / "promo-16x9.jpg", quality=95, subsampling=1)


def make_landscape():
    W, H = 1840, 860
    img = build(W, H, "left")
    s = 120
    icon(img, (70, 132), s)
    ks.draw_title(img, (70, 300), 118, 8)
    d = ImageDraw.Draw(img)
    d.line([(72, 262), (212, 262)], fill=(*CYAN, 160), width=2)
    d.polygon([(72, 256), (82, 262), (72, 268)], fill=(*CYAN, 160))
    img.convert("RGB").save(OUT / "cover-landscape-1840x860.jpg", quality=96, subsampling=1)
    for w, h, name in ((920, 430, "cover-landscape-920x430"), (460, 215, "cover-landscape-460x215")):
        img.convert("RGB").resize((w, h), Image.Resampling.LANCZOS).save(OUT / f"{name}.jpg", quality=96, subsampling=1)


def make_portrait():
    W, H = 1200, 1800
    img = build(W, H, "top")
    s = 140
    icon(img, ((W - s) // 2, 66), s)
    ks.draw_title(img, (348, 248), 120, 8)
    d = ImageDraw.Draw(img)
    d.line([(W // 2 - 110, 420), (W // 2 + 110, 420)], fill=(*CYAN, 80), width=1)
    img.convert("RGB").save(OUT / "cover-portrait-1200x1800.jpg", quality=96, subsampling=1)
    img.convert("RGB").resize((600, 900), Image.Resampling.LANCZOS).save(OUT / "cover-portrait-600x900.jpg", quality=96, subsampling=1)


if __name__ == "__main__":
    make_promo()
    make_landscape()
    make_portrait()
    print("wrote", OUT)
