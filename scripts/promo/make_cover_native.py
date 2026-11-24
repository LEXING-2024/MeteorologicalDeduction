"""Native-map covers with a clean title field."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "promo"))
import make_promos as mp  # noqa: E402
import make_keyart_scene as ks  # noqa: E402

RAW = Image.open(ROOT / "deliverables" / "screenshots" / "14-level-19-three-cities-4k.png").convert("RGB")
OUT = ROOT / "deliverables" / "cover-native"
OUT.mkdir(parents=True, exist_ok=True)
ICON = Image.open(ROOT / "deliverables" / "icon" / "icon-512.png").convert("RGB")
CYAN = (150, 220, 232)


def left_field(w, h, clear=650, alpha=250, solid=0):
    yy, xx = np.mgrid[0:h, 0:w]
    t = np.clip((xx - solid) / max(1, clear - solid), 0, 1)
    t = t * t * (3 - 2 * t)
    a = (alpha * (1 - t)).astype(np.uint8)
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 3] = a
    return Image.fromarray(arr, "RGBA")


def top_field(w, h, clear=520, alpha=250, solid=0):
    yy, xx = np.mgrid[0:h, 0:w]
    t = np.clip((yy - solid) / max(1, clear - solid), 0, 1)
    t = t * t * (3 - 2 * t)
    a = (alpha * (1 - t)).astype(np.uint8)
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 3] = a
    return Image.fromarray(arr, "RGBA")


def base_map(crop, W, H):
    img = RAW.crop(crop).resize((W, H), Image.Resampling.LANCZOS)
    img = ks.grade(img)
    img = ks.bloom(img, 118, 18)
    img = img.convert("RGBA")
    return img


def atmosphere(img, side, glows):
    W, H = img.size
    for (gx, gy, grx, gry, color, alpha) in glows:
        img = Image.alpha_composite(img, ks.radial_glow((W, H), gx, gy, grx, gry, color, alpha))

    fog = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fog)
    fd.ellipse([-300, H - 200, W * 0.6, H + 220], fill=(110, 180, 195, 16))
    fd.ellipse([W * 0.4, H - 180, W + 300, H + 240], fill=(100, 170, 190, 12))
    fog = fog.filter(ImageFilter.GaussianBlur(50))
    img.alpha_composite(fog)

    ks.rain(img, 120)
    img = img.convert("RGB")
    img = mp.vignette(img)
    img = ImageEnhance.Brightness(img).enhance(0.97)
    return img.convert("RGBA")


def icon(img, xy, s):
    img.paste(ICON.resize((s, s), Image.Resampling.LANCZOS), xy)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([xy[0] - 1, xy[1] - 1, xy[0] + s, xy[1] + s], radius=max(8, s // 12),
                        outline=(*CYAN, 115), width=max(1, s // 90))


def make_landscape():
    W, H = 1840, 860
    img = base_map((1350, 600, 3190, 1460), W, H)
    img = Image.alpha_composite(img, left_field(W, H, 660, 252, 0))
    img = atmosphere(img, "left", [
        (120, 300, 300, 260, (55, 180, 165), 48),
        (800, 580, 210, 190, (210, 145, 70), 36),
    ])

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
    img = base_map((1400, 360, 2600, 2160), W, H)
    img = Image.alpha_composite(img, top_field(W, H, 540, 250, 0))
    img = atmosphere(img, "top", [
        (40, 460, 300, 320, (55, 180, 165), 46),
        (750, 820, 210, 200, (210, 145, 70), 34),
        (550, 1490, 170, 150, (80, 190, 210), 22),
    ])

    s = 140
    icon(img, ((W - s) // 2, 66), s)
    ks.draw_title(img, (348, 248), 120, 8)
    d = ImageDraw.Draw(img)
    d.line([(W // 2 - 110, 420), (W // 2 + 110, 420)], fill=(*CYAN, 80), width=1)

    img.convert("RGB").save(OUT / "cover-portrait-1200x1800.jpg", quality=96, subsampling=1)
    img.convert("RGB").resize((600, 900), Image.Resampling.LANCZOS).save(OUT / "cover-portrait-600x900.jpg", quality=96, subsampling=1)


if __name__ == "__main__":
    make_landscape()
    make_portrait()
    print("wrote", OUT)
