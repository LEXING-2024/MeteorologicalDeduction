"""Cover and contact sheet for the 2026 gameplay demo."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "capture" / "demo-run" / "result.png"
LOGO = ROOT / "deliverables" / "logo" / "logo-horizontal-1280.png"
FRAMES = ROOT / "capture" / "demo-run" / "final-frames"
OUT = ROOT / "deliverables"

SANS = "C:/Windows/Fonts/NotoSansSC-VF.ttf"
DIN = "C:/Windows/Fonts/DINNextLTPro-Bold.ttf"
DIN_R = "C:/Windows/Fonts/DINNextLTPro-Regular.ttf"
DIN_M = "C:/Windows/Fonts/DINNextLTPro-Medium.ttf"

WHITE = (245, 251, 253)
CYAN = (150, 220, 232)
GREEN = (120, 225, 185)
DIM = (156, 184, 194)
BG = (5, 14, 21)


def font(path: str, size: int, weight: str | None = None) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(path, size)
    if weight:
        try:
            f.set_variation_by_name(weight)
        except Exception:
            pass
    return f


def tracked(draw: ImageDraw.ImageDraw, xy, text: str, f, fill, tracking: float = 0.0):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + tracking
    return x


def tracked_width(draw, text: str, f, tracking: float = 0.0) -> float:
    return sum(draw.textlength(ch, font=f) + tracking for ch in text) - (tracking if text else 0)


def logo(width: int) -> Image.Image:
    im = Image.open(LOGO).convert("RGBA")
    im = im.crop(im.getbbox())
    h = round(width * im.height / im.width)
    return im.resize((width, h), Image.LANCZOS)


def grade(im: Image.Image) -> Image.Image:
    im = ImageEnhance.Color(im).enhance(1.08)
    im = ImageEnhance.Contrast(im).enhance(1.05)
    im = ImageEnhance.Brightness(im).enhance(0.96)
    # Vignette.
    w, h = im.size
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse((-w * 0.18, -h * 0.22, w * 1.18, h * 1.22), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(180))
    black = Image.new("RGB", (w, h), (0, 0, 0))
    return Image.composite(im, black, mask.point(lambda v: 150 + int(v * 0.41)))


def cover() -> Image.Image:
    src = Image.open(RAW).convert("RGB").resize((1920, 1080), Image.LANCZOS)
    im = grade(src).convert("RGBA")

    # Left title field: near-solid under the lockup, soft edge into the map.
    ys, xs = np.mgrid[0:1080, 0:1920]
    field = np.where(xs < 540, 246.0, np.clip((780 - xs) / 240, 0, 1) * 246.0)
    alpha = field * (0.96 + 0.04 * (ys / 1080))
    mask = Image.fromarray(np.clip(alpha, 0, 248).astype(np.uint8))
    black = Image.new("RGB", (1920, 1080), (2, 8, 12))
    im = Image.composite(black, im.convert("RGB"), mask).convert("RGBA")

    draw = ImageDraw.Draw(im)
    draw.line((62, 714, 522, 714), fill=CYAN + (80,), width=1)
    lg = logo(460)
    im.alpha_composite(lg, (60, 736))

    f_sub = font(SANS, 27, "Light")
    tracked(draw, (64, 868), "实机演示", f_sub, WHITE + (242,), 7)

    f_lv = font(SANS, 17, "Regular")
    draw.text((64, 914), "第 19 关 · 三城记", font=f_lv, fill=DIM + (225,))
    return im.convert("RGB")


def cell(path: Path, size: tuple[int, int], label: str, timecode: str) -> Image.Image:
    im = Image.open(path).convert("RGB")
    tw, th = size
    scale = max(tw / im.width, th / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    left = (im.width - tw) // 2
    top = (im.height - th) // 2
    im = im.crop((left, top, left + tw, top + th)).convert("RGBA")

    # Bottom gradient.
    ys, xs = np.mgrid[0:th, 0:tw]
    a = np.clip((ys - th * 0.58) / (th * 0.42), 0, 1) ** 1.4 * 215
    shade = Image.new("RGBA", (tw, th), (2, 7, 11, 0))
    shade.putalpha(Image.fromarray(a.astype(np.uint8)))
    im = Image.alpha_composite(im, shade)

    draw = ImageDraw.Draw(im)
    f_time = font(DIN, 15)
    f_label = font(SANS, 20, "Medium")
    draw.text((18, th - 54), timecode, font=f_time, fill=CYAN + (235,))
    draw.text((18, th - 32), label, font=f_label, fill=WHITE + (240,))

    # Frame.
    draw.rectangle((0, 0, tw - 1, th - 1), outline=(120, 190, 205, 38), width=1)
    return im


def contact_sheet() -> Image.Image:
    W, H = 1920, 1080
    im = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(im)

    # Subtle grid.
    for x in range(0, W, 80):
        draw.line((x, 0, x, H), fill=(26, 48, 57), width=1)
    for y in range(0, H, 80):
        draw.line((0, y, W, y), fill=(24, 44, 52), width=1)

    f_title = font(SANS, 34, "Bold")
    draw.text((50, 48), "气象推演 · 实机演示", font=f_title, fill=WHITE)
    f_sub = font(SANS, 17, "Regular")
    draw.text((50, 94), "连续实机录制  /  第 19 关「三城记」完整推演", font=f_sub, fill=DIM)

    f_spec = font(DIN_R, 14)
    spec = "1920 × 1080   /   25 FPS   /   01:28"
    sw = tracked_width(draw, spec, f_spec, 2.2)
    tracked(draw, (W - 50 - sw, 58), spec, f_spec, (150, 190, 200), 2.2)
    draw.line((50, 128, W - 50, 128), fill=(120, 190, 205, 45), width=1)

    frames = [
        ("sheet-1.5.png", "00:01", "片头 / 实机演示"),
        ("sheet-5.5.png", "00:05", "全战役 / 六个阶段"),
        ("sheet-16.png", "00:16", "第 19 关 / 三城记"),
        ("sheet-50.png", "00:50", "放置天气系统"),
        ("sheet-76.5.png", "01:16", "三步推演 / 风场 → 降水"),
        ("sheet-81.5.png", "01:21", "目标达成 / 89 mm"),
    ]
    cw, ch = 596, 335
    gap_x, gap_y = 16, 14
    start_x, start_y = 50, 158
    for i, (name, tc, label) in enumerate(frames):
        col, row = i % 3, i // 3
        x = start_x + col * (cw + gap_x)
        y = start_y + row * (ch + gap_y)
        im.paste(cell(FRAMES / name, (cw, ch), label, tc).convert("RGB"), (x, y))

    f_foot = font(SANS, 15, "Regular")
    draw.text((50, 892), "所有画面均来自真实运行的浏览器实机；未使用引擎外合成或伪造数值。", font=f_foot, fill=(140, 166, 176))
    f_foot2 = font(DIN_R, 12)
    ft = "METEOROLOGICAL DEDUCTION  /  2026"
    ftw = tracked_width(draw, ft, f_foot2, 2.6)
    tracked(draw, (W - 50 - ftw, 894), ft, f_foot2, (120, 154, 165), 2.6)
    return im


if __name__ == "__main__":
    c = cover()
    c.save(OUT / "demo-cover-16x9.jpg", quality=94, subsampling=0)
    c.save(OUT / "demo-cover-16x9.png")
    s = contact_sheet()
    s.save(OUT / "demo-contact-sheet.jpg", quality=93, subsampling=0)
    print("wrote", OUT / "demo-cover-16x9.jpg", OUT / "demo-contact-sheet.jpg")


