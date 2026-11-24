"""Hybrid key art: blurred native map colour + crisp vector weather graphics."""
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
OUT = ROOT / "deliverables" / "hybrid-vector"
OUT.mkdir(parents=True, exist_ok=True)


def left_field(w, h, clear=720, alpha=245, solid=0):
    from PIL import Image
    import numpy as np
    yy, xx = np.mgrid[0:h, 0:w]
    t = np.clip((xx - solid) / max(1, clear - solid), 0, 1)
    t = t * t * (3 - 2 * t)
    a = (alpha * (1 - t)).astype(np.uint8)
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 3] = a
    return Image.fromarray(arr, "RGBA")


def make_promo():
    W, H = 1920, 1080
    ss = 2
    w, h = W * ss, H * ss

    base = RAW.crop((850, 330, 3150, 1623)).resize((w, h), Image.Resampling.LANCZOS)
    base = base.filter(ImageFilter.GaussianBlur(42))
    base = ImageEnhance.Brightness(base).enhance(1.45)
    base = ImageEnhance.Color(base).enhance(1.45)
    base = ImageEnhance.Contrast(base).enhance(1.10)
    base = base.convert("RGBA")

    # darken so vector lines read
    base = Image.alpha_composite(base, Image.new("RGBA", (w, h), (4, 12, 18, 110)))

    u = min(w, h)
    s = u / 1080.0
    low = (0.352 * w, 0.410 * h)
    high = (0.696 * w, 0.657 * h)

    art = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(art)

    # high cell
    for i, r in enumerate((70, 118, 168, 220, 272)):
        rich.isobar(d, high[0], high[1], r * s, 0.9 + i * 0.5, rich.AMBER,
                    78 if i < 3 else 55, max(2, round((2 if i < 2 else 1.4) * s)))
    rich.pressure_center(d, high[0], high[1], "H", rich.AMBER, scale=0.92 * s, letters=False)

    # low cell
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

    base = Image.alpha_composite(base, ks.radial_glow((w, h), low[0], low[1], u * 0.3, u * 0.26, (55, 180, 165), 55))
    base = Image.alpha_composite(base, ks.radial_glow((w, h), high[0], high[1], u * 0.18, u * 0.16, (210, 145, 70), 38))

    base = Image.alpha_composite(base, left_field(w, h, 1450, 245, 0))
    base = base.convert("RGB").resize((W, H), Image.Resampling.LANCZOS)

    # foreground rain
    img = base.convert("RGBA")
    ks.rain(img, 120)
    img = img.convert("RGB")

    # title
    title_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ks.draw_title(title_layer, (120, 790), 124, 10)
    img = Image.alpha_composite(img.convert("RGBA"), title_layer)
    d = ImageDraw.Draw(img)
    d.line([(120, 744), (270, 744)], fill=(*rich.CYAN, 170), width=2)
    d.polygon([(120, 738), (130, 744), (120, 750)], fill=(*rich.CYAN, 170))
    d.line([(122, 936), (600, 936)], fill=(*rich.CYAN, 80), width=1)

    img.convert("RGB").save(OUT / "promo-16x9.jpg", quality=95, subsampling=1)
    print("wrote", OUT)


if __name__ == "__main__":
    make_promo()
