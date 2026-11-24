"""Cinematic key art from the native 4K weather map.

Composition: native map shifted right, dark title field on the left,
atmospheric bloom / rain / fog, designed title.  No screenshot frame.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "promo"))
import make_promos as mp  # noqa: E402

RAW = ROOT / "deliverables" / "screenshots" / "14-level-19-three-cities-4k.png"
OUT = ROOT / "deliverables" / "keyart-scene"
OUT.mkdir(parents=True, exist_ok=True)
ICON = Image.open(ROOT / "deliverables" / "icon" / "icon-512.png").convert("RGB")

WHITE = (248, 253, 255)
CYAN = (150, 220, 232)
AMBER = (235, 185, 120)


def grade(img: Image.Image) -> Image.Image:
    img = ImageEnhance.Brightness(img).enhance(136 / 100)
    img = ImageEnhance.Contrast(img).enhance(1.10)
    img = ImageEnhance.Color(img).enhance(1.22)
    arr = np.asarray(img, dtype=np.float32)
    # teal shadows, warm highlights
    lum = arr.mean(axis=2, keepdims=True) / 255.0
    shadow = np.clip(1 - lum * 1.6, 0, 1)
    high = np.clip((lum - 0.55) * 2.2, 0, 1)
    arr += shadow * np.array([-4, 8, 12], dtype=np.float32)
    arr += high * np.array([10, 4, -4], dtype=np.float32)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def radial_glow(size, cx, cy, rx, ry, color, alpha, power=2.0):
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    m = np.clip(1 - r, 0, 1) ** power
    layer = np.zeros((h, w, 4), dtype=np.uint8)
    layer[..., 0], layer[..., 1], layer[..., 2] = color
    layer[..., 3] = np.clip(m * alpha, 0, 255).astype(np.uint8)
    return Image.fromarray(layer, "RGBA")


def left_field(w: int, h: int, clear: int = 720, alpha: int = 246, solid: int = 360) -> Image.Image:
    yy, xx = np.mgrid[0:h, 0:w]
    t = np.clip((xx - solid) / max(1, clear - solid), 0, 1)
    t = t * t * (3 - 2 * t)
    a = (alpha * (1 - t)).astype(np.uint8)
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 3] = a
    return Image.fromarray(arr, "RGBA")


def bloom(img: Image.Image, threshold=135, radius=18) -> Image.Image:
    arr = np.asarray(img, dtype=np.float32)
    mask = np.clip((arr.max(axis=2) - threshold) / (255 - threshold), 0, 1)
    bright = (arr * mask[..., None]).astype(np.uint8)
    b = Image.fromarray(bright).filter(ImageFilter.GaussianBlur(radius))
    b = ImageEnhance.Brightness(b).enhance(1.25)
    out = np.clip(np.asarray(img, dtype=np.float32) + np.asarray(b, dtype=np.float32) * 0.55, 0, 255)
    return Image.fromarray(out.astype(np.uint8))


def gradient_text(text, font, top=(253, 255, 255), bottom=(205, 242, 250)):
    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    bbox = probe.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad = 6
    w, h = tw + pad * 2, th + pad * 2
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.text((pad - bbox[0], pad - bbox[1]), text, font=font, fill=255)

    grad = Image.new("RGB", (w, h), top)
    gd = ImageDraw.Draw(grad)
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
        gd.line([(0, y), (w, y)], fill=c)
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    layer.paste(grad, (0, 0), mask)
    return layer, (pad - bbox[0], pad - bbox[1])


def draw_title(base: Image.Image, xy, size: int, tracking: int) -> None:
    d = ImageDraw.Draw(base)
    f = mp.font(mp.FONT_B, size)
    text = "气象推演"
    widths = [d.textlength(ch, font=f) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x, y = xy

    # outer glow
    glow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gx = x
    for ch, cw in zip(text, widths):
        gd.text((gx, y), ch, font=f, fill=(*CYAN, 95))
        gx += cw + tracking
    glow = glow.filter(ImageFilter.GaussianBlur(26))
    base.alpha_composite(glow)

    # deep shadow
    sh = Image.new("RGBA", base.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sx = x
    for ch, cw in zip(text, widths):
        sd.text((sx + 4, y + 10), ch, font=f, fill=(0, 0, 0, 235))
        sx += cw + tracking
    sh = sh.filter(ImageFilter.GaussianBlur(7))
    base.alpha_composite(sh)

    # crisp dark outline
    ol = Image.new("RGBA", base.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(ol)
    ox = x
    for ch, cw in zip(text, widths):
        od.text((ox, y), ch, font=f, fill=(4, 12, 18, 235),
                stroke_width=3, stroke_fill=(4, 12, 18, 235))
        ox += cw + tracking
    base.alpha_composite(ol)

    # gradient fill per character so tracking is preserved
    cx = x
    for ch, cw in zip(text, widths):
        layer, off = gradient_text(ch, f)
        base.alpha_composite(layer, (int(cx - off[0]), int(y - off[1])))
        cx += cw + tracking


def rain(base: Image.Image, amount=140, seed=9):
    W, H = base.size
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    rng = np.random.default_rng(seed)
    for _ in range(amount):
        x = rng.uniform(-120, W + 120)
        y = rng.uniform(-80, H)
        ln = rng.uniform(14, 62)
        a = int(rng.integers(14, 55))
        d.line([(x, y), (x - ln * 0.20, y + ln)], fill=(190, 230, 238, a), width=1)
    base.alpha_composite(layer)


def make_scene() -> Image.Image:
    W, H = 1920, 1080
    raw = Image.open(RAW).convert("RGB")

    # background: the same map, heavily blurred and dark
    bg = raw.crop((500, 120, 3200, 2050)).resize((W, H), Image.Resampling.LANCZOS)
    bg = bg.filter(ImageFilter.GaussianBlur(40))
    bg = ImageEnhance.Brightness(bg).enhance(0.40)
    bg = Image.alpha_composite(bg.convert("RGBA"), Image.new("RGBA", (W, H), (3, 12, 18, 150)))

    # native map, shifted right to leave a title field
    map_img = raw.crop((850, 330, 3150, 1623)).resize((W, H), Image.Resampling.LANCZOS)
    map_img = grade(map_img)
    map_img = bloom(map_img, 118, 18)

    bg.alpha_composite(map_img.convert("RGBA"), (250, 0))

    # glow around the A low / B high, on top of the map
    bg = Image.alpha_composite(bg, radial_glow((W, H), 676, 443, 360, 300, (55, 180, 165), 55))
    bg = Image.alpha_composite(bg, radial_glow((W, H), 1336, 710, 230, 210, (210, 145, 70), 38))

    # left title field
    bg = Image.alpha_composite(bg, left_field(W, H, 760, 252, 360))

    # subtle HUD grid over the map
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(250, W, 96):
        gd.line([(x, 0), (x, H)], fill=(150, 205, 218, 7), width=1)
    for y in range(0, H, 96):
        gd.line([(0, y), (W, y)], fill=(150, 205, 218, 7), width=1)
    bg.alpha_composite(grid)

    # fog at the bottom / top
    fog = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fog)
    fd.ellipse([-300, 860, 900, 1300], fill=(110, 180, 195, 18))
    fd.ellipse([700, 900, 1900, 1350], fill=(100, 170, 190, 14))
    fog = fog.filter(ImageFilter.GaussianBlur(55))
    bg.alpha_composite(fog)

    rain(bg, 150)

    # interaction cue: glowing cursor over the low-pressure token
    ring = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    rx, ry, rr = 1043, 810, 74
    for i in range(28):
        if i % 2 == 0:
            a0 = i * 360 / 28
            rd.arc([rx - rr, ry - rr, rx + rr, ry + rr], a0, a0 + 8,
                   fill=(*CYAN, 120), width=2)
    ring = ring.filter(ImageFilter.GaussianBlur(2))
    bg.alpha_composite(ring)

    cur = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(cur)
    cx, cy = 1090, 866
    pts = [(cx, cy), (cx + 2, cy + 42), (cx + 11, cy + 33), (cx + 19, cy + 51),
           (cx + 29, cy + 47), (cx + 21, cy + 29), (cx + 34, cy + 27)]
    cd.polygon(pts, fill=(245, 253, 255, 245), outline=(6, 18, 24, 240))
    cd.line([(cx + 2, cy + 4), (cx + 11, cy + 13)], fill=(*CYAN, 230), width=2)
    glo = cur.filter(ImageFilter.GaussianBlur(10))
    bg.alpha_composite(glo)
    bg.alpha_composite(cur)

    # a few out-of-focus foreground streaks for depth
    fg = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fg)
    rng = np.random.default_rng(41)
    for _ in range(16):
        x = rng.uniform(150, W)
        y = rng.uniform(-50, H)
        ln = rng.uniform(60, 160)
        fd.line([(x, y), (x - ln * 0.18, y + ln)], fill=(200, 238, 246, 18), width=3)
    fg = fg.filter(ImageFilter.GaussianBlur(3))
    bg.alpha_composite(fg)

    # HUD corner brackets
    br = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(br)
    for (x, y, dx, dy) in ((44, 42, 1, 1), (W - 44, 42, -1, 1), (44, H - 44, 1, -1), (W - 44, H - 44, -1, -1)):
        bd.line([(x, y), (x + dx * 54, y)], fill=(*CYAN, 75), width=1)
        bd.line([(x, y), (x, y + dy * 54)], fill=(*CYAN, 75), width=1)
    bg.alpha_composite(br)

    # vignette
    bg = bg.convert("RGB")
    bg = mp.vignette(bg)
    bg = ImageEnhance.Brightness(bg).enhance(0.96)
    return bg.convert("RGBA")


def make_promo() -> None:
    W, H = 1920, 1080
    img = make_scene()
    d = ImageDraw.Draw(img)
    d.line([(120, 744), (270, 744)], fill=(*CYAN, 170), width=2)
    d.polygon([(120, 738), (130, 744), (120, 750)], fill=(*CYAN, 170))
    draw_title(img, (120, 790), 124, 10)
    d = ImageDraw.Draw(img)
    d.line([(122, 936), (600, 936)], fill=(*CYAN, 80), width=1)
    img.convert("RGB").save(OUT / "promo-16x9.jpg", quality=95, subsampling=1)
    img.convert("RGB").save(OUT / "promo-16x9.png", optimize=True)


if __name__ == "__main__":
    make_promo()
    print("wrote", OUT)
