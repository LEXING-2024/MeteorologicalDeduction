"""Richer TapTap artwork built from the game's own weather-map language.

No copy except the game title.  The 16:9 image is drawn, not a screenshot:
isobars, H/L cells, wind field, fronts, rain shield and city nodes.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "promo"))
import make_promos as mp  # noqa: E402

OUT = ROOT / "deliverables" / "taptap"
OUT.mkdir(parents=True, exist_ok=True)
COVERS = ROOT / "deliverables" / "covers"
PROMO = ROOT / "deliverables" / "promotional"
ICON_PATH = ROOT / "deliverables" / "icon" / "icon-512.png"

WHITE = (245, 251, 253)
CYAN = (150, 220, 232)
GREEN = (120, 225, 185)
AMBER = (235, 185, 120)
WIND = (205, 235, 242)


# ---------------------------------------------------------------- helpers
def noise2d(w: int, h: int, cells: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    small = rng.normal(0, 1, (max(2, h // cells), max(2, w // cells))).astype(np.float32)
    small = np.clip(small * 0.5 + 0.5, 0, 1) * 255
    img = Image.fromarray(small.astype(np.uint8)).resize((w, h), Image.Resampling.BICUBIC)
    return np.asarray(img, dtype=np.float32) / 255.0


def base_layer(w: int, h: int, low: tuple[float, float], high: tuple[float, float] | None) -> Image.Image:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    t = (yy / max(1, h - 1))[..., None]
    top = np.array([7, 16, 24], dtype=np.float32)
    bottom = np.array([10, 30, 42], dtype=np.float32)
    col = top * (1 - t) + bottom * t

    lx, ly = low
    r = np.sqrt(((xx - lx) / (w * 0.72)) ** 2 + ((yy - ly) / (h * 0.78)) ** 2)
    glow = np.clip(1 - r, 0, 1) ** 2.1
    col += glow[..., None] * np.array([2, 24, 30], dtype=np.float32)

    if high is not None:
        hx, hy = high
        rh = np.sqrt(((xx - hx) / (w * 0.30)) ** 2 + ((yy - hy) / (h * 0.34)) ** 2)
        gh = np.clip(1 - rh, 0, 1) ** 2.4
        col += gh[..., None] * np.array([16, 11, 5], dtype=np.float32)

    mottle = noise2d(w, h, max(18, min(w, h) // 26), 31)
    col += (mottle[..., None] - 0.5) * 5.5
    return Image.fromarray(np.clip(col, 0, 255).astype(np.uint8), "RGB")


def soft_blob(w: int, h: int, cx: float, cy: float, rx: float, ry: float,
              power: float = 1.7, seed: int = 3) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
    m = np.clip(1 - d, 0, 1) ** power
    n = noise2d(w, h, max(10, int(min(rx, ry) / 12)), seed)
    m = np.clip(m * (0.78 + 0.44 * n), 0, 1)
    return m


def add_mask(img: Image.Image, mask: np.ndarray, color: tuple[int, int, int], alpha: float) -> Image.Image:
    h, w = mask.shape
    layer = np.zeros((h, w, 4), dtype=np.uint8)
    layer[..., 0], layer[..., 1], layer[..., 2] = color
    layer[..., 3] = np.clip(mask * alpha, 0, 255).astype(np.uint8)
    return Image.alpha_composite(img.convert("RGBA"), Image.fromarray(layer, "RGBA"))


def vignette(img: Image.Image, strength: float = 0.38) -> Image.Image:
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt(((xx - w / 2) / (w * 0.58)) ** 2 + ((yy - h / 2) / (h * 0.58)) ** 2)
    v = 1 - strength * np.clip((r - 0.52) / 0.95, 0, 1) ** 1.35
    arr = np.asarray(img, dtype=np.float32) * v[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def grain(img: Image.Image, amount: float = 2.2) -> Image.Image:
    arr = np.asarray(img, dtype=np.float32)
    rng = np.random.default_rng(17)
    noise = rng.normal(0, amount, arr.shape[:2])[..., None]
    return Image.fromarray(np.clip(arr + noise, 0, 255).astype(np.uint8))


def left_fade(w: int, h: int, clear: float = 0.50, alpha: int = 232) -> Image.Image:
    yy, xx = np.mgrid[0:h, 0:w]
    t = np.clip(xx / (w * clear), 0, 1)
    t = t * t * (3 - 2 * t)
    a = (alpha * (1 - t)).astype(np.uint8)
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 3] = a
    return Image.fromarray(arr, "RGBA")


def top_fade(w: int, h: int, clear: float = 0.42, alpha: int = 246) -> Image.Image:
    yy, xx = np.mgrid[0:h, 0:w]
    t = np.clip(yy / (h * clear), 0, 1)
    t = t * t * (3 - 2 * t)
    a = (alpha * (1 - t)).astype(np.uint8)
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 3] = a
    return Image.fromarray(arr, "RGBA")


# ---------------------------------------------------------------- map art
def isobar(d: ImageDraw.ImageDraw, cx: float, cy: float, radius: float, phase: float,
           color: tuple[int, int, int], alpha: int, width: int, wobble: float = 0.035) -> None:
    pts = []
    for i in range(241):
        th = 2 * math.pi * i / 240
        rr = radius * (1 + wobble * math.sin(3 * th + phase)
                       + wobble * 0.5 * math.sin(5 * th - phase * 1.4)
                       + wobble * 0.25 * math.sin(8 * th + phase * 0.7))
        pts.append((cx + rr * math.cos(th), cy + rr * math.sin(th) * 0.94))
    d.line(pts, fill=(*color, alpha), width=width, joint="curve")


def wind_at(x: float, y: float, low: tuple[float, float], high: tuple[float, float] | None,
            scale: float) -> tuple[float, float]:
    vx = vy = 0.0
    lx, ly = low
    dx, dy = x - lx, y - ly
    r = math.hypot(dx, dy) + 1e-6
    w = math.exp(-r / scale)
    vx += (-dy / r) * w + (dx / r) * 0.20 * w
    vy += (dx / r) * w + (dy / r) * 0.20 * w
    if high is not None:
        hx, hy = high
        dx, dy = x - hx, y - hy
        r = math.hypot(dx, dy) + 1e-6
        w = 0.55 * math.exp(-r / (scale * 0.9))
        vx += (dy / r) * w + (dx / r) * 0.12 * w
        vy += (-dx / r) * w + (dy / r) * 0.12 * w
    return vx, vy


def arrow(d: ImageDraw.ImageDraw, x: float, y: float, ang: float, length: float,
          color: tuple[int, int, int], alpha: int, width: int = 1) -> None:
    ex, ey = x + math.cos(ang) * length, y + math.sin(ang) * length
    d.line([(x, y), (ex, ey)], fill=(*color, alpha), width=width)
    a = 0.48
    d.line([(ex, ey), (ex - math.cos(ang - a) * length * 0.28,
                      ey - math.sin(ang - a) * length * 0.28)],
           fill=(*color, alpha), width=width)
    d.line([(ex, ey), (ex - math.cos(ang + a) * length * 0.28,
                      ey - math.sin(ang + a) * length * 0.28)],
           fill=(*color, alpha), width=width)


def wind_field(d: ImageDraw.ImageDraw, w: int, h: int, low: tuple[float, float],
               high: tuple[float, float] | None, step: int, scale: float) -> None:
    for y in range(step // 2, h, step):
        for x in range(step // 2, w, step):
            vx, vy = wind_at(x, y, low, high, scale)
            m = math.hypot(vx, vy) + 1e-6
            if m < 0.06:
                continue
            ang = math.atan2(vy, vx)
            # fade arrows away from the systems a little
            r = math.hypot(x - low[0], y - low[1])
            a = int(np.clip(125 - r / (scale * 7), 42, 125))
            arrow(d, x, y, ang, step * 0.34, WIND, a, 1)


def glyph_H(d: ImageDraw.ImageDraw, cx: float, cy: float, size: float,
            color: tuple[int, int, int]) -> None:
    w = size * 0.135
    h = size * 0.82
    left = cx - size * 0.28
    right = cx + size * 0.28 - w
    top = cy - h / 2
    bot = cy + h / 2
    d.rounded_rectangle([left, top, left + w, bot], radius=w * 0.25, fill=(*color, 245))
    d.rounded_rectangle([right, top, right + w, bot], radius=w * 0.25, fill=(*color, 245))
    d.rounded_rectangle([left, cy - w * 0.5, right + w, cy + w * 0.5],
                        radius=w * 0.25, fill=(*color, 245))


def glyph_L(d: ImageDraw.ImageDraw, cx: float, cy: float, size: float,
            color: tuple[int, int, int]) -> None:
    w = size * 0.135
    h = size * 0.82
    left = cx - size * 0.24
    top = cy - h / 2
    d.rounded_rectangle([left, top, left + w, cy + h / 2], radius=w * 0.25,
                        fill=(*color, 245))
    d.rounded_rectangle([left, cy + h / 2 - w, left + size * 0.62, cy + h / 2],
                        radius=w * 0.25, fill=(*color, 245))


def vortex_mark(d: ImageDraw.ImageDraw, cx: float, cy: float, kind: str,
                color: tuple[int, int, int], scale: float = 1.0) -> None:
    """Graphic pressure centre: no letters, for the no-logo artwork."""
    s = scale
    for r, a in ((46 * s, 20), (34 * s, 30)):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*color, a))
    d.ellipse([cx - 34 * s, cy - 34 * s, cx + 34 * s, cy + 34 * s],
              outline=(*color, 210), width=max(2, round(2.4 * s)))
    d.ellipse([cx - 27 * s, cy - 27 * s, cx + 27 * s, cy + 27 * s],
              outline=(*color, 95), width=max(1, round(1.2 * s)))
    d.ellipse([cx - 4 * s, cy - 4 * s, cx + 4 * s, cy + 4 * s], fill=(*color, 240))
    for i in range(4):
        th = math.pi / 4 + i * math.pi / 2
        if kind == "L":
            r0, r1 = 50 * s, 27 * s
            ang = th + math.pi
        else:
            r0, r1 = 20 * s, 48 * s
            ang = th
        x0, y0 = cx + r0 * math.cos(th), cy + r0 * math.sin(th)
        arrow(d, x0, y0, ang, abs(r1 - r0) * 1.05, color, 220, max(1, round(2 * s)))


def pressure_center(d: ImageDraw.ImageDraw, cx: float, cy: float, kind: str,
                    color: tuple[int, int, int], scale: float = 1.0,
                    letters: bool = True) -> None:
    s = scale
    # soft halo
    for r, a in ((74 * s, 20), (56 * s, 30)):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*color, a))
    d.ellipse([cx - 46 * s, cy - 46 * s, cx + 46 * s, cy + 46 * s],
              fill=(7, 16, 23, 225), outline=(*color, 210), width=max(2, round(2.2 * s)))
    d.ellipse([cx - 37 * s, cy - 37 * s, cx + 37 * s, cy + 37 * s],
              outline=(*color, 95), width=max(1, round(1.2 * s)))
    if not letters:
        vortex_mark(d, cx, cy, kind, color, s)
    elif kind == "H":
        glyph_H(d, cx, cy, 54 * s, color)
    else:
        glyph_L(d, cx, cy, 54 * s, color)


def cold_front(d: ImageDraw.ImageDraw, pts: list[tuple[float, float]], side: float,
               color=(132, 190, 220), width: int = 5, size: float = 20) -> None:
    d.line(pts, fill=(*color, 185), width=width, joint="curve")
    for i in range(1, len(pts) - 1):
        x, y = pts[i]
        nx, ny = pts[i + 1][0] - pts[i - 1][0], pts[i + 1][1] - pts[i - 1][1]
        m = math.hypot(nx, ny) + 1e-6
        nx, ny = nx / m, ny / m
        px, py = -ny * side, nx * side
        tip = (x + px * size, y + py * size)
        base1 = (x - nx * size * 0.52, y - ny * size * 0.52)
        base2 = (x + nx * size * 0.52, y + ny * size * 0.52)
        d.polygon([base1, base2, tip], fill=(*color, 175))


def warm_front(d: ImageDraw.ImageDraw, pts: list[tuple[float, float]], side: float,
               color=(238, 165, 130), width: int = 5, size: float = 15) -> None:
    d.line(pts, fill=(*color, 165), width=width, joint="curve")
    for i in range(1, len(pts) - 1):
        x, y = pts[i]
        nx, ny = pts[i + 1][0] - pts[i - 1][0], pts[i + 1][1] - pts[i - 1][1]
        ang = math.atan2(ny * side, nx * side)
        deg = math.degrees(ang)
        d.pieslice([x - size, y - size, x + size, y + size], deg, deg + 180,
                   fill=(*color, 155))


def city_node(d: ImageDraw.ImageDraw, x: float, y: float, s: float = 1.0) -> None:
    for r, a in ((34 * s, 16), (23 * s, 26)):
        d.ellipse([x - r, y - r, x + r, y + r], fill=(190, 238, 244, a))
    d.ellipse([x - 18 * s, y - 18 * s, x + 18 * s, y + 18 * s],
              outline=(215, 244, 248, 185), width=max(1, round(1.6 * s)))
    d.ellipse([x - 9 * s, y - 9 * s, x + 9 * s, y + 9 * s],
              outline=(215, 244, 248, 120), width=1)
    d.ellipse([x - 3 * s, y - 3 * s, x + 3 * s, y + 3 * s], fill=(235, 250, 252, 235))
    d.line([(x - 28 * s, y), (x - 12 * s, y)], fill=(215, 244, 248, 140), width=1)
    d.line([(x + 12 * s, y), (x + 28 * s, y)], fill=(215, 244, 248, 140), width=1)
    d.line([(x, y - 28 * s), (x, y - 12 * s)], fill=(215, 244, 248, 140), width=1)
    d.line([(x, y + 12 * s), (x, y + 28 * s)], fill=(215, 244, 248, 140), width=1)


def rain_shield(img: Image.Image, cx: float, cy: float, rx: float, ry: float,
                seed: int = 5) -> Image.Image:
    # layered moisture field: green edge, teal middle, blue core
    m_outer = soft_blob(*img.size, cx, cy, rx, ry, 1.5, seed)
    m_mid = soft_blob(*img.size, cx - rx * 0.04, cy - ry * 0.02, rx * 0.78, ry * 0.78, 1.7, seed + 1)
    m_core = soft_blob(*img.size, cx - rx * 0.10, cy - ry * 0.04, rx * 0.50, ry * 0.52, 1.9, seed + 2)
    m_deep = soft_blob(*img.size, cx - rx * 0.13, cy - ry * 0.06, rx * 0.28, ry * 0.30, 2.0, seed + 3)

    img = add_mask(img, m_outer, (92, 214, 158), 72)
    img = add_mask(img, m_mid, (62, 172, 178), 66)
    img = add_mask(img, m_core, (66, 108, 196), 82)
    img = add_mask(img, m_deep, (52, 74, 172), 98)

    # fine rain hatching inside the shield
    w, h = img.size
    hatch = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hatch)
    step = max(22, round(min(w, h) / 46))
    for i in range(-h, w, step):
        hd.line([(i, 0), (i + h * 0.32, h)], fill=(185, 235, 245, 32), width=2)
    ha = np.array(hatch)
    ha[..., 3] = (ha[..., 3].astype(np.float32) * m_outer).astype(np.uint8)
    img = Image.alpha_composite(img, Image.fromarray(ha, "RGBA"))

    # sparse rain streaks
    rng = np.random.default_rng(seed + 9)
    dots = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    for _ in range(int(rx * ry / 2600)):
        a = rng.uniform(0, 2 * math.pi)
        rr = math.sqrt(rng.uniform(0, 1))
        x = cx + math.cos(a) * rx * rr
        y = cy + math.sin(a) * ry * rr
        ln = rng.uniform(4, 10)
        dd.line([(x, y), (x - 2.5, y + ln)], fill=(200, 242, 250, int(90 * (1 - rr))), width=1)
    da = np.array(dots)
    da[..., 3] = (da[..., 3].astype(np.float32) * m_outer).astype(np.uint8)
    return Image.alpha_composite(img, Image.fromarray(da, "RGBA"))


def weather_scene(w: int, h: int, low: tuple[float, float],
                  high: tuple[float, float] | None, title_safe: str,
                  fade_clear: float = 0.52, fade_alpha: int = 210,
                  letters: bool = True) -> Image.Image:
    img = base_layer(w, h, low, high).convert("RGBA")

    # graticule
    grid = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    step = max(90, round(min(w, h) / 9))
    for x in range(0, w, step):
        gd.line([(x, 0), (x, h)], fill=(160, 205, 218, 12), width=1)
    for y in range(0, h, step):
        gd.line([(0, y), (w, y)], fill=(160, 205, 218, 12), width=1)
    img = Image.alpha_composite(img, grid)

    lx, ly = low
    u = min(w, h)
    s = u / 1080.0
    scale = u * 0.34
    rx, ry = u * 0.46, u * 0.34

    img = rain_shield(img, lx - rx * 0.05, ly - ry * 0.02, rx, ry)

    art = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(art)

    # high cell
    if high is not None:
        hx, hy = high
        for i, r in enumerate((70, 118, 168, 220, 272)):
            isobar(d, hx, hy, r * s, 0.9 + i * 0.5, AMBER, 78 if i < 3 else 55,
                   max(2, round((2 if i < 2 else 1.4) * s)))
        pressure_center(d, hx, hy, "H", AMBER, scale=0.92 * s, letters=letters)

    # low cell: dense isobars
    for i, r in enumerate((96, 148, 202, 258, 316, 376, 438, 502, 568)):
        isobar(d, lx, ly, r * s, 0.35 + i * 0.42, CYAN, 165 if i < 4 else 125,
               max(2, round((3 if i < 2 else 2.2) * s)))
    pressure_center(d, lx, ly, "L", (135, 225, 210), scale=1.05 * s, letters=letters)

    # wind arrows across the whole chart
    wind_field(d, w, h, low, high, step=max(48, round(min(w, h) / 18)), scale=scale)

    # fronts trailing from the low
    u = min(w, h)
    cold = [(lx - 16, ly + 18), (lx - u * 0.10, ly + u * 0.14), (lx - u * 0.22, ly + u * 0.28),
            (lx - u * 0.36, ly + u * 0.42), (lx - u * 0.50, ly + u * 0.56)]
    cold_front(d, cold, side=-1, width=max(3, round(u / 330)), size=u * 0.022)
    warm = [(lx + 22, ly + 8), (lx + u * 0.10, ly + u * 0.075), (lx + u * 0.21, ly + u * 0.115),
            (lx + u * 0.33, ly + u * 0.12), (lx + u * 0.43, ly + u * 0.09)]
    warm_front(d, warm, side=-1, width=max(3, round(u / 350)), size=u * 0.017)

    # city nodes, no labels
    city_node(d, lx - u * 0.015, ly - u * 0.055, s=u / 1500)
    city_node(d, lx + u * 0.20, ly + u * 0.16, s=u / 1650)
    city_node(d, lx - u * 0.20, ly + u * 0.31, s=u / 1750)

    img = Image.alpha_composite(img, art)

    # warm sector tint
    yy, xx = np.mgrid[0:h, 0:w]
    warm_mask = np.clip(1 - (((xx - (lx + u * 0.22)) / (u * 0.42)) ** 2 +
                             ((yy - (ly + u * 0.10)) / (u * 0.28)) ** 2), 0, 1) ** 2
    tint = np.zeros((h, w, 4), dtype=np.uint8)
    tint[..., 0], tint[..., 1], tint[..., 2] = AMBER
    tint[..., 3] = (warm_mask * 12).astype(np.uint8)
    img = Image.alpha_composite(img, Image.fromarray(tint, "RGBA"))

    # legibility gradient
    if title_safe == "left":
        img = Image.alpha_composite(img, left_fade(w, h, clear=fade_clear, alpha=fade_alpha))
    elif title_safe == "top":
        img = Image.alpha_composite(img, top_fade(w, h, clear=0.42, alpha=246))

    flat = vignette(img.convert("RGB"), 0.34)
    return grain(flat, 2.0)


# ---------------------------------------------------------------- type
def draw_title(img: Image.Image, xy: tuple[int, int], size: int, tracking: int,
               anchor: str = "la") -> None:
    d = ImageDraw.Draw(img)
    f = mp.font(mp.FONT_B, size)
    x, y = xy
    widths = [d.textlength(ch, font=f) for ch in "气象推演"]
    total = sum(widths) + tracking * 3
    if anchor == "ma":
        x -= total / 2
    elif anchor == "ra":
        x -= total

    # soft dark halo so the title reads over the chart without hiding it
    halo = Image.new("RGBA", img.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hx = x
    for ch, cw in zip("气象推演", widths):
        hd.text((hx, y), ch, font=f, fill=(0, 0, 0, 235))
        hx += cw + tracking
    halo = halo.filter(ImageFilter.GaussianBlur(max(4, size * 0.10)))
    base = Image.alpha_composite(img.convert("RGBA"), halo)
    img.paste(base.convert("RGB"), (0, 0))

    d = ImageDraw.Draw(img)
    d.text((x + 2, y + 4), "气象推演", font=f, fill=(0, 0, 0, 150), anchor="la")
    for ch, cw in zip("气象推演", widths):
        d.text((x, y), ch, font=f, fill=WHITE)
        x += cw + tracking


def rule(img: Image.Image, x: int, y: int, length: int, alpha: int = 170) -> None:
    d = ImageDraw.Draw(img)
    d.line([(x, y), (x + length, y)], fill=(*CYAN, alpha), width=2)
    d.polygon([(x - 1, y - 5), (x + 8, y), (x - 1, y + 5)], fill=(*CYAN, alpha))


def paste_icon(img: Image.Image, xy: tuple[int, int], size: int) -> None:
    icon = Image.open(ICON_PATH).convert("RGB").resize((size, size), Image.Resampling.LANCZOS)
    img.paste(icon, xy)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([xy[0] - 1, xy[1] - 1, xy[0] + size, xy[1] + size],
                        radius=max(6, size // 12), outline=(*CYAN, 95), width=max(1, size // 90))


# ---------------------------------------------------------------- outputs
def make_promo() -> None:
    W, H = 1920, 1080
    ss = 2
    img = weather_scene(W * ss, H * ss, low=(0.635 * W * ss, 0.52 * H * ss),
                        high=(0.85 * W * ss, 0.26 * H * ss), title_safe="left",
                        fade_clear=0.60, fade_alpha=205, letters=False)
    img = img.resize((W, H), Image.Resampling.LANCZOS)
    draw_title(img, (300, 792), 104, 8)
    rule(img, 300, 742, 118)
    img.convert("RGB").save(OUT / "promo-16x9.jpg", quality=95, subsampling=1)
    img.convert("RGB").save(OUT / "promo-16x9.png", optimize=True)
    img.convert("RGB").save(PROMO / "keyart-16x9.jpg", quality=95, subsampling=1)
    img.convert("RGB").save(PROMO / "keyart-16x9.png", optimize=True)


def make_landscape() -> None:
    W, H = 1840, 860
    ss = 2
    img = weather_scene(W * ss, H * ss, low=(0.64 * W * ss, 0.52 * H * ss),
                        high=(0.86 * W * ss, 0.26 * H * ss), title_safe="left",
                        fade_clear=0.60, fade_alpha=210, letters=False)
    img = img.resize((W, H), Image.Resampling.LANCZOS)

    icon_s, gap = 140, 30
    x0, y0 = 104, 260
    paste_icon(img, (x0, y0), icon_s)
    draw_title(img, (x0 + icon_s + gap, y0 + 2), 146, 6)

    img.convert("RGB").save(OUT / "cover-landscape-1840x860.jpg", quality=96, subsampling=1)
    img.convert("RGB").save(OUT / "cover-landscape-1840x860.png", optimize=True)
    img.convert("RGB").save(COVERS / "landscape-1840x860.jpg", quality=96, subsampling=1)
    img.convert("RGB").save(COVERS / "landscape-1840x860.png", optimize=True)
    for w, h, name in ((920, 430, "cover-landscape-920x430"),
                       (460, 215, "cover-landscape-460x215")):
        im = img.resize((w, h), Image.Resampling.LANCZOS)
        im.convert("RGB").save(OUT / f"{name}.jpg", quality=96, subsampling=1)
        im.convert("RGB").save(OUT / f"{name}.png", optimize=True)
        short = name.replace("cover-", "")
        im.convert("RGB").save(COVERS / f"{short}.jpg", quality=96, subsampling=1)
        im.convert("RGB").save(COVERS / f"{short}.png", optimize=True)


def make_portrait() -> None:
    W, H = 1200, 1800
    ss = 2
    img = weather_scene(W * ss, H * ss, low=(0.52 * W * ss, 0.66 * H * ss),
                        high=None, title_safe="top", letters=False)
    img = img.resize((W, H), Image.Resampling.LANCZOS)

    icon_s = 156
    icon_x, icon_y = (W - icon_s) // 2, 132
    paste_icon(img, (icon_x, icon_y), icon_s)
    draw_title(img, (W // 2, 352), 138, 7, anchor="ma")

    img.convert("RGB").save(OUT / "cover-portrait-1200x1800.jpg", quality=96, subsampling=1)
    img.convert("RGB").save(OUT / "cover-portrait-1200x1800.png", optimize=True)
    img.convert("RGB").save(COVERS / "portrait-1200x1800.jpg", quality=96, subsampling=1)
    img.convert("RGB").save(COVERS / "portrait-1200x1800.png", optimize=True)
    im = img.resize((600, 900), Image.Resampling.LANCZOS)
    im.convert("RGB").save(OUT / "cover-portrait-600x900.jpg", quality=96, subsampling=1)
    im.convert("RGB").save(OUT / "cover-portrait-600x900.png", optimize=True)
    im.convert("RGB").save(COVERS / "portrait-600x900.jpg", quality=96, subsampling=1)
    im.convert("RGB").save(COVERS / "portrait-600x900.png", optimize=True)


def main() -> None:
    make_promo()
    # Covers are wordmark-only and built by make_covers_wordmark.py.
    # Keeping the old icon-led cover functions out of the default run avoids
    # silently overwriting that set.
    mp.make_contact_sheet()
    print("wrote richer artwork to", OUT)


if __name__ == "__main__":
    main()
