"""Editorial full-bleed key art and TapTap covers from native 4K gameplay."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "promo"))
import make_promos as mp  # noqa: E402

SRC = ROOT / "capture" / "library" / "canvas-keyart-4k.png"
LOGO = ROOT / "deliverables" / "logo" / "logo-horizontal-1280.png"
OUT = ROOT / "deliverables" / "covers"
PROMO = ROOT / "deliverables" / "promotional"
TAP = ROOT / "deliverables" / "taptap"
TMP = ROOT / "capture" / "editorial"
TMP.mkdir(parents=True, exist_ok=True)
CYAN = (150, 220, 232)


def logo(width: int) -> Image.Image:
    im = Image.open(LOGO).convert("RGBA")
    im = im.crop(im.getbbox())
    h = round(width * im.height / im.width)
    return im.resize((width, h), Image.Resampling.LANCZOS)


def cover_crop(crop, size):
    im = Image.open(SRC).convert("RGB").crop(crop)
    # Cover-fit, in case the crop and target aspect differ slightly.
    tw, th = size
    scale = max(tw / im.width, th / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.Resampling.LANCZOS)
    left = (im.width - tw) // 2
    top = (im.height - th) // 2
    return im.crop((left, top, left + tw, top + th))


def grade(im: Image.Image) -> Image.Image:
    im = ImageEnhance.Color(im).enhance(1.26)
    im = ImageEnhance.Contrast(im).enhance(1.10)
    im = ImageEnhance.Brightness(im).enhance(0.92)

    a = np.array(im, dtype=np.float32) / 255.0
    lum = a.max(axis=2, keepdims=True)
    # Lift shadows toward navy, push highlights toward icy cyan.
    shadow = np.array([5, 14, 22], dtype=np.float32) / 255.0
    high = np.array([196, 240, 248], dtype=np.float32) / 255.0
    a = shadow + a * (high - shadow) * 0.92

    # Soft cyan bloom from the brightest rain / contour areas.
    bright = np.clip((lum - 0.55) / 0.45, 0, 1) ** 1.5
    bloom_src = (a * bright).astype(np.float32)
    b = Image.fromarray(np.clip(bloom_src * 255, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(26))
    ba = np.array(b, dtype=np.float32) / 255.0
    a = 1 - (1 - a) * (1 - ba * 0.35)

    im = Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8))
    return im


def atmosphere(im: Image.Image, seed=7) -> Image.Image:
    w, h = im.size
    rng = np.random.default_rng(seed)

    # Rain streaks.
    rain = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(rain)
    for _ in range(int(w * h / 5200)):
        x = rng.uniform(-0.1, 1.05) * w
        y = rng.uniform(-0.1, 1.05) * h
        ln = rng.uniform(18, 58) * (w / 1920)
        dx = rng.uniform(4, 9) * (w / 1920)
        d.line([(x, y), (x + dx, y + ln)], fill=(180, 225, 235, int(rng.uniform(14, 34))), width=1)
    im = Image.alpha_composite(im.convert("RGBA"), rain)

    # Low fog.
    fog = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fog)
    for y in range(int(h * 0.55), h):
        t = max(0.0, (y - h * 0.55) / (h * 0.45))
        fd.line([(0, y), (w, y)], fill=(16, 42, 52, int(50 * t ** 1.5)))
    fog = fog.filter(ImageFilter.GaussianBlur(40))
    im = Image.alpha_composite(im, fog)

    # Vignette.
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse((-w * 0.16, -h * 0.20, w * 1.16, h * 1.20), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(170))
    black = Image.new("RGB", (w, h), (0, 0, 0))
    im = Image.composite(im.convert("RGB"), black, mask.point(lambda v: 120 + int(v * 0.52))).convert("RGBA")
    return im


def scrim(im: Image.Image, corner="bottom-left", strength=225):
    w, h = im.size
    ys, xs = np.mgrid[0:h, 0:w]
    if corner == "bottom-left":
        fx = 1 - xs / (w * 0.66)
        fy = (ys - h * 0.36) / (h * 0.64)
    else:
        fx = 1 - xs / (w * 0.78)
        fy = 1 - ys / (h * 0.52)
    a = np.clip(fx, 0, 1) ** 1.15 * np.clip(fy, 0, 1) ** 1.2 * strength
    mask = Image.fromarray(np.clip(a, 0, 235).astype(np.uint8))
    black = Image.new("RGB", (w, h), (2, 7, 11))
    return Image.composite(black, im.convert("RGB"), mask).convert("RGBA")


def place_title(im: Image.Image, xy, width: int):
    lg = logo(width)
    shadow = Image.new("RGBA", (im.width, im.height), (0, 0, 0, 0))
    sh = lg.split()[3].point(lambda v: int(v * 0.75))
    black = Image.new("RGBA", lg.size, (0, 0, 0, 0))
    black.putalpha(sh)
    shadow.alpha_composite(black, (xy[0] + 5, xy[1] + 9))
    shadow = shadow.filter(ImageFilter.GaussianBlur(10))
    im = Image.alpha_composite(im, shadow)
    im.alpha_composite(lg, xy)
    return im


def save(im: Image.Image, path: Path, max_bytes=None):
    rgb = im.convert("RGB")
    rgb.save(path, quality=96, subsampling=1)
    if max_bytes and path.stat().st_size > max_bytes:
        q = 92
        while q > 70 and path.stat().st_size > max_bytes:
            rgb.save(path, quality=q, subsampling=1)
            q -= 2


def make_16x9():
    im = cover_crop((650, 250, 3050, 1600), (1920, 1080))
    im = grade(im)
    im = atmosphere(im, 11)
    im = scrim(im, "top-left", 232)
    im = place_title(im, (74, 62), 680)
    save(im, PROMO / "keyart-16x9.jpg")
    save(im, PROMO / "keyart-16x9.png")
    save(im, TAP / "promo-16x9.jpg")
    save(im, TAP / "promo-16x9.png")
    save(im, TMP / "keyart-16x9.jpg")


def make_landscape():
    im = cover_crop((600, 460, 3100, 1630), (1840, 860))
    im = grade(im)
    im = atmosphere(im, 23)
    im = scrim(im, "top-left", 232)
    im = place_title(im, (64, 46), 700)
    for w, h, name in ((1840, 860, "landscape-1840x860"), (920, 430, "landscape-920x430"),
                       (460, 215, "landscape-460x215")):
        im2 = im.resize((w, h), Image.Resampling.LANCZOS)
        save(im2, OUT / f"{name}.jpg")
        save(im2, OUT / f"{name}.png")
        save(im2, TAP / f"cover-{name}.jpg")
        save(im2, TAP / f"cover-{name}.png")


def make_portrait():
    im = cover_crop((780, 300, 1980, 2100), (1200, 1800))
    im = grade(im)
    im = atmosphere(im, 31)
    im = scrim(im, "top-left", 230)
    im = place_title(im, (60, 60), 740)
    for w, h, name in ((1200, 1800, "portrait-1200x1800"), (600, 900, "portrait-600x900")):
        im2 = im.resize((w, h), Image.Resampling.LANCZOS)
        save(im2, OUT / f"{name}.jpg")
        save(im2, OUT / f"{name}.png")
        save(im2, TAP / f"cover-{name}.jpg")
        save(im2, TAP / f"cover-{name}.png")


if __name__ == "__main__":
    make_16x9()
    make_landscape()
    make_portrait()
    print("wrote editorial set to", TMP)










