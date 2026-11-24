"""Cinematic key art built from the native 4K gameplay map.

Prototype for the TapTap promo / covers.  The map is presented as a tilted
holographic weather table, with atmospheric depth, rain, and a designed
title treatment.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "promo"))
import make_promos as mp  # noqa: E402

RAW = ROOT / "deliverables" / "screenshots" / "14-level-19-three-cities-4k.png"
OUT = ROOT / "deliverables" / "keyart-v2"
OUT.mkdir(parents=True, exist_ok=True)
ICON = Image.open(ROOT / "deliverables" / "icon" / "icon-512.png").convert("RGB")

WHITE = (245, 251, 253)
CYAN = (150, 220, 232)
AMBER = (235, 185, 120)


def find_coeffs(pa, pb):
    matrix = []
    for p1, p2 in zip(pa, pb):
        matrix.append([p1[0], p1[1], 1, 0, 0, 0, -p2[0] * p1[0], -p2[0] * p1[1]])
        matrix.append([0, 0, 0, p1[0], p1[1], 1, -p2[1] * p1[0], -p2[1] * p1[1]])
    A = np.matrix(matrix, dtype=float)
    B = np.array(pb).reshape(8)
    res = np.dot(np.linalg.inv(A.T * A) * A.T, B)
    return np.array(res).reshape(8)


def perspective(img: Image.Image, quad: list[tuple[float, float]], size: tuple[int, int]) -> Image.Image:
    w, h = img.size
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    coeffs = find_coeffs(quad, src)
    return img.transform(size, Image.PERSPECTIVE, coeffs, Image.Resampling.BICUBIC)


def load_map(crop: tuple[int, int, int, int], size: tuple[int, int]) -> Image.Image:
    img = Image.open(RAW).convert("RGB").crop(crop)
    return img.resize(size, Image.Resampling.LANCZOS)


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def add_panel(base: Image.Image, panel: Image.Image, quad, radius=28) -> None:
    W, H = base.size
    # shadow
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sh.paste(Image.new("RGBA", panel.size, (0, 0, 0, 200)), (0, 0), rounded_mask(panel.size, radius))
    sh = perspective(sh, quad, (W, H))
    sh = sh.filter(ImageFilter.GaussianBlur(28))
    sh = Image.eval(sh, lambda v: v)
    base.alpha_composite(sh, (18, 32))

    # panel itself
    p = panel.convert("RGBA")
    p.putalpha(rounded_mask(panel.size, radius))
    p = perspective(p, quad, (W, H))
    base.alpha_composite(p)

    # rim light
    rim = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(rim)
    d.line(quad + [quad[0]], fill=(*CYAN, 210), width=2, joint="curve")
    glow = rim.filter(ImageFilter.GaussianBlur(7))
    base.alpha_composite(glow)
    base.alpha_composite(rim)


def gradient_text(text: str, font, width: int, height: int, top=(250, 254, 255), bottom=(120, 205, 220)) -> Image.Image:
    mask = Image.new("L", (width, height), 0)
    d = ImageDraw.Draw(mask)
    d.text((2, 2), text, font=font, fill=255)

    grad = Image.new("RGB", (width, height), top)
    gd = ImageDraw.Draw(grad)
    for y in range(height):
        t = y / max(1, height - 1)
        c = tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
        gd.line([(0, y), (width, y)], fill=c)

    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    layer.paste(grad, (0, 0), mask)
    return layer


def title_block(base: Image.Image, xy, size: int, tracking: int, icon: bool = False) -> None:
    d = ImageDraw.Draw(base)
    f = mp.font(mp.FONT_B, size)
    widths = [d.textlength(ch, font=f) for ch in "气象推演"]
    total = sum(widths) + tracking * 3
    x, y = xy
    # glow behind
    glow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gx = x
    for ch, cw in zip("气象推演", widths):
        gd.text((gx, y), ch, font=f, fill=(*CYAN, 100))
        gx += cw + tracking
    glow = glow.filter(ImageFilter.GaussianBlur(22))
    base.alpha_composite(glow)

    # hard shadow
    sh = Image.new("RGBA", base.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sx = x
    for ch, cw in zip("气象推演", widths):
        sd.text((sx + 4, y + 8), ch, font=f, fill=(0, 0, 0, 220))
        sx += cw + tracking
    sh = sh.filter(ImageFilter.GaussianBlur(6))
    base.alpha_composite(sh)

    layer = gradient_text("气象推演", f, base.width, base.height)
    base.alpha_composite(layer, (x, y))

    if icon:
        s = int(size * 1.08)
        ix, iy = x, y - s - 22
        base.paste(ICON.resize((s, s), Image.Resampling.LANCZOS), (ix, iy))
        d = ImageDraw.Draw(base)
        d.rounded_rectangle([ix - 1, iy - 1, ix + s, iy + s], radius=max(8, s // 12),
                            outline=(*CYAN, 110), width=max(1, s // 90))


def rain(base: Image.Image, amount=120) -> None:
    W, H = base.size
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    rng = np.random.default_rng(5)
    for _ in range(amount):
        x = rng.uniform(-100, W + 100)
        y = rng.uniform(-50, H)
        ln = rng.uniform(18, 70)
        a = int(rng.integers(18, 60))
        d.line([(x, y), (x - ln * 0.22, y + ln)], fill=(190, 230, 238, int(a)), width=1)
    base.alpha_composite(layer)


def make_promo() -> None:
    W, H = 1920, 1080
    # background: blurred native map, very dark
    bg = Image.open(RAW).convert("RGB").crop((500, 80, 3200, 2080)).resize((W, H), Image.Resampling.LANCZOS)
    bg = bg.filter(ImageFilter.GaussianBlur(34))
    bg = Image.eval(bg, lambda v: int(v * 0.46))
    bg = bg.convert("RGBA")

    # cool grade
    tint = Image.new("RGBA", (W, H), (4, 18, 26, 110))
    bg = Image.alpha_composite(bg, tint)

    # radial glow behind panel
    yy, xx = np.mgrid[0:H, 0:W]
    r = np.sqrt(((xx - 1280) / 760) ** 2 + ((yy - 480) / 620) ** 2)
    glow = np.clip(1 - r, 0, 1) ** 2
    g = np.zeros((H, W, 4), dtype=np.uint8)
    g[..., 0], g[..., 1], g[..., 2] = 20, 70, 82
    g[..., 3] = (glow * 60).astype(np.uint8)
    bg = Image.alpha_composite(bg, Image.fromarray(g, "RGBA"))

    panel = load_map((700, 180, 3020, 1980), (1500, 1180))
    quad = [(820, 118), (1840, 70), (1870, 920), (790, 1010)]
    add_panel(bg, panel, quad, radius=26)

    # reflection under panel
    ref = panel.convert("RGBA")
    ref.putalpha(rounded_mask(panel.size, 26))
    ref = perspective(ref, quad, (W, H)).transpose(Image.FLIP_TOP_BOTTOM)
    ref = ref.filter(ImageFilter.GaussianBlur(4))
    ref.putalpha(ref.getchannel("A").point(lambda v: int(v * 0.10)))
    bg.alpha_composite(ref, (0, 40))

    # foreground rain and fog
    rain(bg, 160)
    fog = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fog)
    for i in range(6):
        x = 300 + i * 300
        fd.ellipse([x - 380, 900, x + 380, 1250], fill=(120, 190, 205, 10))
    fog = fog.filter(ImageFilter.GaussianBlur(60))
    bg.alpha_composite(fog)

    # left legibility
    grad = mp.gradient_mask(W, H, 0.58)
    bg = Image.alpha_composite(bg, grad)

    title_block(bg, (300, 770), 120, 10)

    # accent line
    d = ImageDraw.Draw(bg)
    d.line([(300, 726), (440, 726)], fill=(*CYAN, 170), width=2)
    d.polygon([(300, 720), (310, 726), (300, 732)], fill=(*CYAN, 170))

    bg.convert("RGB").save(OUT / "promo-16x9.jpg", quality=95, subsampling=1)


if __name__ == "__main__":
    make_promo()
    print("wrote", OUT)
