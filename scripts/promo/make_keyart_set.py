"""Cinematic native-map key art set: 16:9 promo + two covers."""
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
OUT = ROOT / "deliverables" / "keyart-set"
OUT.mkdir(parents=True, exist_ok=True)
ICON = Image.open(ROOT / "deliverables" / "icon" / "icon-512.png").convert("RGB")
CYAN = (150, 220, 232)


def top_field(w: int, h: int, clear: int = 480, alpha: int = 246, solid: int = 0) -> Image.Image:
    yy, xx = np.mgrid[0:h, 0:w]
    t = np.clip((yy - solid) / max(1, clear - solid), 0, 1)
    t = t * t * (3 - 2 * t)
    a = (alpha * (1 - t)).astype(np.uint8)
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 3] = a
    return Image.fromarray(arr, "RGBA")


def build(W: int, H: int, crop, offset: tuple[int, int], side: str,
          glow_a, glow_b, ring, cursor) -> Image.Image:
    bg = RAW.crop(crop).resize((W, H), Image.Resampling.LANCZOS)
    bg = bg.filter(ImageFilter.GaussianBlur(40))
    bg = ImageEnhance.Brightness(bg).enhance(0.40)
    bg = Image.alpha_composite(bg.convert("RGBA"), Image.new("RGBA", (W, H), (3, 12, 18, 150)))

    map_img = RAW.crop(crop).resize((W, H), Image.Resampling.LANCZOS)
    map_img = ks.grade(map_img)
    map_img = ks.bloom(map_img, 118, 18)
    bg.alpha_composite(map_img.convert("RGBA"), offset)

    bg = Image.alpha_composite(bg, ks.radial_glow((W, H), glow_a[0], glow_a[1], 360, 300, (55, 180, 165), 55))
    bg = Image.alpha_composite(bg, ks.radial_glow((W, H), glow_b[0], glow_b[1], 230, 210, (210, 145, 70), 38))

    if side == "left":
        bg = Image.alpha_composite(bg, ks.left_field(W, H, 760, 252, 360))
    else:
        bg = Image.alpha_composite(bg, top_field(W, H, 500, 250, 0))

    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(offset[0], W, 96):
        gd.line([(x, 0), (x, H)], fill=(150, 205, 218, 7), width=1)
    for y in range(0, H, 96):
        gd.line([(0, y), (W, y)], fill=(150, 205, 218, 7), width=1)
    bg.alpha_composite(grid)

    fog = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fog)
    fd.ellipse([-300, H - 220, W * 0.55, H + 220], fill=(110, 180, 195, 18))
    fd.ellipse([W * 0.35, H - 180, W + 300, H + 260], fill=(100, 170, 190, 14))
    fog = fog.filter(ImageFilter.GaussianBlur(55))
    bg.alpha_composite(fog)

    ks.rain(bg, 150)

    # interaction cue
    ring_img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring_img)
    rx, ry, rr = ring
    for i in range(28):
        if i % 2 == 0:
            a0 = i * 360 / 28
            rd.arc([rx - rr, ry - rr, rx + rr, ry + rr], a0, a0 + 8,
                   fill=(*CYAN, 120), width=2)
    bg.alpha_composite(ring_img.filter(ImageFilter.GaussianBlur(2)))

    cur = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(cur)
    cx, cy = cursor
    pts = [(cx, cy), (cx + 2, cy + 42), (cx + 11, cy + 33), (cx + 19, cy + 51),
           (cx + 29, cy + 47), (cx + 21, cy + 29), (cx + 34, cy + 27)]
    cd.polygon(pts, fill=(245, 253, 255, 245), outline=(6, 18, 24, 240))
    cd.line([(cx + 2, cy + 4), (cx + 11, cy + 13)], fill=(*CYAN, 230), width=2)
    bg.alpha_composite(cur.filter(ImageFilter.GaussianBlur(10)))
    bg.alpha_composite(cur)

    fg = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fg)
    rng = np.random.default_rng(41)
    for _ in range(16):
        x = rng.uniform(150, W)
        y = rng.uniform(-50, H)
        ln = rng.uniform(60, 160)
        fd.line([(x, y), (x - ln * 0.18, y + ln)], fill=(200, 238, 246, 18), width=3)
    bg.alpha_composite(fg.filter(ImageFilter.GaussianBlur(3)))

    br = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(br)
    for (x, y, dx, dy) in ((44, 42, 1, 1), (W - 44, 42, -1, 1), (44, H - 44, 1, -1), (W - 44, H - 44, -1, -1)):
        bd.line([(x, y), (x + dx * 54, y)], fill=(*CYAN, 75), width=1)
        bd.line([(x, y), (x, y + dy * 54)], fill=(*CYAN, 75), width=1)
    bg.alpha_composite(br)

    bg = bg.convert("RGB")
    bg = mp.vignette(bg)
    bg = ImageEnhance.Brightness(bg).enhance(0.96)
    return bg.convert("RGBA")


def paste_icon(img, xy, s):
    img.paste(ICON.resize((s, s), Image.Resampling.LANCZOS), xy)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([xy[0] - 1, xy[1] - 1, xy[0] + s, xy[1] + s], radius=max(8, s // 12),
                        outline=(*CYAN, 110), width=max(1, s // 90))


def make_promo() -> None:
    W, H = 1920, 1080
    img = build(W, H, (850, 330, 3150, 1623), (250, 0), "left",
                glow_a=(676, 443), glow_b=(1336, 710),
                ring=(1043, 810, 74), cursor=(1090, 866))
    d = ImageDraw.Draw(img)
    d.line([(120, 744), (270, 744)], fill=(*CYAN, 170), width=2)
    d.polygon([(120, 738), (130, 744), (120, 750)], fill=(*CYAN, 170))
    ks.draw_title(img, (120, 790), 124, 10)
    d = ImageDraw.Draw(img)
    d.line([(122, 936), (600, 936)], fill=(*CYAN, 80), width=1)
    img.convert("RGB").save(OUT / "promo-16x9.jpg", quality=95, subsampling=1)


def make_landscape() -> None:
    W, H = 1840, 860
    img = build(W, H, (850, 330, 3150, 1405), (450, 0), "left",
                glow_a=(858, 424), glow_b=(1490, 680),
                ring=(1210, 776, 58), cursor=(1250, 822))
    s = 140
    paste_icon(img, (100, 280), s)
    ks.draw_title(img, (100 + s + 30, 282), 136, 8)
    img.convert("RGB").save(OUT / "cover-landscape-1840x860.jpg", quality=96, subsampling=1)
    for w, h, name in ((920, 430, "cover-landscape-920x430"), (460, 215, "cover-landscape-460x215")):
        img.convert("RGB").resize((w, h), Image.Resampling.LANCZOS).save(OUT / f"{name}.jpg", quality=96, subsampling=1)


def make_portrait() -> None:
    W, H = 1200, 1800
    img = build(W, H, (850, 200, 2200, 2225), (-50, 0), "top",
                glow_a=(403, 587), glow_b=(1106, 871),
                ring=(794, 978, 64), cursor=(838, 1030))
    s = 156
    paste_icon(img, ((W - s) // 2, 110), s)
    ks.draw_title(img, (W // 2 - 300, 320), 132, 8)
    d = ImageDraw.Draw(img)
    d.line([(W // 2 - 120, 492), (W // 2 + 120, 492)], fill=(*CYAN, 80), width=1)
    img.convert("RGB").save(OUT / "cover-portrait-1200x1800.jpg", quality=96, subsampling=1)
    img.convert("RGB").resize((600, 900), Image.Resampling.LANCZOS).save(OUT / "cover-portrait-600x900.jpg", quality=96, subsampling=1)


if __name__ == "__main__":
    make_promo()
    make_landscape()
    make_portrait()
    print("wrote", OUT)
