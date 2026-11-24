"""Title and end cards for the 2026 gameplay demo."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SHOT = ROOT / "deliverables" / "screenshots" / "14-level-19-three-cities-4k.png"
LOGO = ROOT / "deliverables" / "logo" / "logo-horizontal-1280.png"
OUT = ROOT / "deliverables" / "promotional"
OUT.mkdir(parents=True, exist_ok=True)

W, H = 1920, 1080
SANS = "C:/Windows/Fonts/NotoSansSC-VF.ttf"
DIN = "C:/Windows/Fonts/DINNextLTPro-Bold.ttf"
DIN_R = "C:/Windows/Fonts/DINNextLTPro-Regular.ttf"

NAVY = (5, 14, 21)
CYAN = (150, 220, 232)
WHITE = (245, 251, 253)
DIM = (156, 184, 194)


def font(path: str, size: int, weight: str | None = None) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(path, size)
    if weight:
        try:
            f.set_variation_by_name(weight)
        except Exception:
            pass
    return f


def cover(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    tw, th = size
    scale = max(tw / im.width, th / im.height)
    nw, nh = round(im.width * scale), round(im.height * scale)
    im = im.resize((nw, nh), Image.LANCZOS)
    left = (nw - tw) // 2
    top = (nh - th) // 2
    return im.crop((left, top, left + tw, top + th))


def tracked(draw: ImageDraw.ImageDraw, xy, text, f, fill, tracking=0):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + tracking
    return x


def tracked_width(draw, text, f, tracking=0):
    return sum(draw.textlength(ch, font=f) + tracking for ch in text) - (tracking if text else 0)


def base_plate() -> Image.Image:
    src = Image.open(SHOT).convert("RGB")
    # The storm core and the A/B isobars, no UI sidebars.
    crop = src.crop((850, 330, 3150, 1623))
    im = cover(crop, (W, H))
    im = im.filter(ImageFilter.GaussianBlur(6.4))
    im = ImageEnhance.Color(im).enhance(1.22)
    im = ImageEnhance.Contrast(im).enhance(1.08)
    im = ImageEnhance.Brightness(im).enhance(0.52)

    # Navy grade.
    tint = Image.new("RGB", (W, H), NAVY)
    im = Image.blend(im, tint, 0.40)

    # Left-side legibility gradient.
    grad = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(grad)
    for x in range(W):
        t = max(0.0, 1.0 - x / 1180.0)
        gd.line((x, 0, x, H), fill=int(200 * (t ** 1.25)))
    dark = Image.new("RGB", (W, H), (3, 9, 14))
    im = Image.composite(dark, im, grad.point(lambda v: int(v * 0.9)))

    # Cyan glow behind the title.
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for r in range(760, 0, -8):
        a = int(30 * (1 - r / 760) ** 2)
        gd.ellipse((330 - r, 520 - r, 330 + r, 520 + r), fill=(8, 34, 42))
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    im = Image.fromarray(np.clip(np.array(im).astype(np.int16) + np.array(glow).astype(np.int16) * 0.85, 0, 255).astype(np.uint8))

    # Faint chart grid.
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(0, W, 96):
        gd.line((x, 0, x, H), fill=(120, 190, 205, 7))
    for y in range(0, H, 96):
        gd.line((0, y, W, y), fill=(120, 190, 205, 7))
    im = Image.alpha_composite(im.convert("RGBA"), grid).convert("RGB")

    # Vignette.
    vig = Image.new("L", (W, H), 0)
    vd = ImageDraw.Draw(vig)
    vd.ellipse((-W * 0.22, -H * 0.25, W * 1.22, H * 1.25), fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(180))
    black = Image.new("RGB", (W, H), (0, 0, 0))
    im = Image.composite(im, black, vig.point(lambda v: 80 + int(v * 0.7)))
    return im


def logo_layer(width: int) -> Image.Image:
    im = Image.open(LOGO).convert("RGBA")
    im = im.crop(im.getbbox())
    h = round(width * im.height / im.width)
    return im.resize((width, h), Image.LANCZOS)


def intro() -> Image.Image:
    im = base_plate().convert("RGBA")
    draw = ImageDraw.Draw(im)

    # Eyebrow.
    f_eye = font(DIN, 19)
    ex, ey = 184, 286
    draw.ellipse((ex, ey + 8, ex + 7, ey + 15), fill=CYAN + (255,))
    tracked(draw, (ex + 22, ey), "GAMEPLAY DEMO", f_eye, CYAN + (235,), 4.6)
    draw.line((ex, ey + 52, ex + 868, ey + 52), fill=(150, 220, 232, 46), width=1)

    # Logo.
    lg = logo_layer(880)
    im.alpha_composite(lg, (180, 360))

    # Subtitle.
    f_sub = font(SANS, 48, "Light")
    tracked(draw, (184, 640), "实机演示", f_sub, WHITE + (242,), 16)

    f_note = font(SANS, 19, "Regular")
    draw.text((184, 954), "连续实机录制 · 浏览器实机画面", font=f_note, fill=DIM + (210,))

    f_foot = font(DIN_R, 13)
    ft = "METEOROLOGICAL DEDUCTION"
    ftw = tracked_width(draw, ft, f_foot, 4.2)
    tracked(draw, (W - 184 - ftw, 956), ft, f_foot, (150, 190, 200, 150), 4.2)
    return im.convert("RGB")


def outro() -> Image.Image:
    im = base_plate()
    im = ImageEnhance.Brightness(im).enhance(0.78).convert("RGBA")
    draw = ImageDraw.Draw(im)

    lg = logo_layer(760)
    lx = (W - lg.width) // 2
    im.alpha_composite(lg, (lx, 386))

    draw.line((W // 2 - 190, 646, W // 2 + 190, 646), fill=(150, 220, 232, 66), width=1)

    f_sub = font(SANS, 28, "Light")
    sub = "实 机 演 示"
    sw = tracked_width(draw, sub, f_sub, 6)
    tracked(draw, ((W - sw) / 2, 684), sub, f_sub, WHITE + (232,), 6)

    f_line = font(SANS, 23, "Regular")
    line = "风场  ·  垂直运动  ·  降水"
    lw = draw.textlength(line, font=f_line)
    draw.text(((W - lw) / 2, 748), line, font=f_line, fill=DIM + (200,))

    f_foot = font(DIN_R, 12)
    ft = "GAMEPLAY DEMO  /  2026"
    ftw = tracked_width(draw, ft, f_foot, 4)
    tracked(draw, ((W - ftw) / 2, 984), ft, f_foot, (118, 154, 165, 145), 4)
    return im.convert("RGB")


if __name__ == "__main__":
    a = intro()
    b = outro()
    a.save(OUT / "demo-intro-16x9.png")
    b.save(OUT / "demo-outro-16x9.png")
    a.save(OUT / "demo-intro-16x9.jpg", quality=94, subsampling=0)
    b.save(OUT / "demo-outro-16x9.jpg", quality=94, subsampling=0)
    print("wrote", OUT / "demo-intro-16x9.png", OUT / "demo-outro-16x9.png")

