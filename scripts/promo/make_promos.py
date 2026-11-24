"""Build a small set of TapTap / social promotional graphics."""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "capture" / "raw"
ICON = ROOT / "deliverables" / "icon" / "icon-512.png"
OUT = ROOT / "deliverables" / "promotional"
OUT.mkdir(parents=True, exist_ok=True)

FONT_B = "C:/Windows/Fonts/Noto Sans SC Bold (TrueType).otf"
FONT_M = "C:/Windows/Fonts/Noto Sans SC Medium (TrueType).otf"
FONT_R = "C:/Windows/Fonts/Noto Sans SC (TrueType).otf"
FONT_DIN = "C:/Windows/Fonts/DINNextLTPro-Bold.ttf"
FONT_MONO = "C:/Windows/Fonts/CascadiaMono.ttf"

WHITE = (242, 250, 252)
MUTED = (166, 190, 203)
DIM = (110, 134, 147)
CYAN = (139, 212, 223)
GREEN = (142, 224, 196)
AMBER = (230, 178, 110)


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def tracked(draw, xy, text, f, fill, tracking=0.0, anchor="left"):
    widths = [draw.textlength(ch, font=f) for ch in text]
    total = sum(widths) + tracking * max(0, len(text) - 1)
    x, y = xy
    if anchor == "center":
        x -= total / 2
    elif anchor == "right":
        x -= total
    for ch, width in zip(text, widths):
        draw.text((x, y), ch, font=f, fill=fill)
        x += width + tracking


def shadow(draw, xy, text, f, fill, anchor="la"):
    draw.text((xy[0] + 1, xy[1] + 3), text, font=f, fill=(0, 0, 0, 180), anchor=anchor)
    draw.text(xy, text, font=f, fill=fill, anchor=anchor)


def tracked_shadow(draw, xy, text, f, fill, tracking=0.0, anchor="left"):
    widths = [draw.textlength(ch, font=f) for ch in text]
    total = sum(widths) + tracking * max(0, len(text) - 1)
    x, y = xy
    if anchor == "center":
        x -= total / 2
    elif anchor == "right":
        x -= total
    shadow(draw, (x + 1, y + 2), text, f, (0, 0, 0, 180), anchor="la")
    # re-draw with proper tracking
    cx = x
    for ch, width in zip(text, widths):
        draw.text((cx, y), ch, font=f, fill=fill)
        cx += width + tracking


def cover(path: Path, size: tuple[int, int], focus=(0.5, 0.5), zoom=1.0) -> Image.Image:
    img = Image.open(path).convert("RGB")
    tw, th = size
    scale = max(tw / img.width, th / img.height) * zoom
    resized = img.resize((round(img.width * scale), round(img.height * scale)), Image.Resampling.LANCZOS)
    cx, cy = focus[0] * resized.width, focus[1] * resized.height
    left = min(max(cx - tw / 2, 0), resized.width - tw)
    top = min(max(cy - th / 2, 0), resized.height - th)
    return resized.crop((left, top, left + tw, top + th))


def gradient_mask(w: int, h: int, left_fade: float = 0.55) -> Image.Image:
    yy, xx = np.mgrid[0:h, 0:w]
    fade = np.clip((xx - w * 0.34) / (w * left_fade), 0, 1)
    fade = fade * fade * (3 - 2 * fade)
    alpha = (248 * (1 - fade)).astype(np.uint8)
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 3] = alpha
    return Image.fromarray(arr, "RGBA")


def bottom_mask(w: int, h: int) -> Image.Image:
    yy, xx = np.mgrid[0:h, 0:w]
    alpha = (190 * np.clip((yy - h * 0.55) / (h * 0.45), 0, 1) ** 1.3).astype(np.uint8)
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 3] = alpha
    return Image.fromarray(arr, "RGBA")


def vignette(img: Image.Image) -> Image.Image:
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
    v = 1 - 0.24 * np.clip((r - 0.45) / 1.05, 0, 1) ** 1.4
    arr = np.asarray(img, dtype=np.float32) * v[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def brand(draw, x, y, icon: Image.Image, scale=1.0):
    s = round(58 * scale)
    ic = icon.resize((s, s), Image.Resampling.LANCZOS)
    draw.rounded_rectangle([x - 2, y - 2, x + s + 2, y + s + 2], radius=12, outline=(139, 212, 223, 90), width=1)
    return ic, (x, y, s)


def paste_icon(board: Image.Image, draw, x, y, icon: Image.Image, s=58):
    ic = icon.resize((s, s), Image.Resampling.LANCZOS)
    board.paste(ic, (x, y))
    draw.rounded_rectangle([x - 1, y - 1, x + s, y + s], radius=11, outline=(139, 212, 223, 90), width=1)


def top_brand(board: Image.Image, draw, icon: Image.Image, label="气象推演", x=96, y=74, scale=1.0):
    s = round(56 * scale)
    paste_icon(board, draw, x, y, icon, s)
    f1 = font(FONT_B, round(25 * scale))
    f2 = font(FONT_MONO, round(11 * scale))
    draw.text((x + s + 20, y + 3), label, font=f1, fill=WHITE)
    tracked(draw, (x + s + 21, y + 36), "METEOROLOGICAL DEDUCTION", f2, (139, 212, 223), tracking=1.4)


def footer(board: Image.Image, draw, left="极光视界工作室", right="72 关战役 · 25 关现已开放"):
    f = font(FONT_M, 15)
    draw.text((96, 996), left, font=f, fill=DIM)
    tracked(draw, (1824, 996), right, f, (139, 212, 223), tracking=0.6, anchor="right")


def make_kv(icon: Image.Image) -> None:
    W, H = 1920, 1080
    bg = cover(RAW / "19-three-cities-result.png", (W, H), focus=(0.53, 0.5), zoom=1.0)
    bg = Image.alpha_composite(bg.convert("RGBA"), gradient_mask(W, H, 0.62))
    bg = Image.alpha_composite(bg, bottom_mask(W, H)).convert("RGB")
    bg = vignette(bg).convert("RGBA")
    d = ImageDraw.Draw(bg)

    top_brand(bg, d, icon)
    tracked(d, (96, 290), "2D 气象推演解谜  /  DESKTOP BROWSER", font(FONT_M, 15), CYAN, tracking=2.2)
    shadow(d, (92, 320), "气象推演", font(FONT_B, 132), WHITE)
    shadow(d, (96, 500), "你只负责气压差，剩下的交给大气。", font(FONT_M, 30), MUTED)

    # stats
    y = 610
    x = 96
    for number, label, fnum in (("72", "关战役", 58), ("25", "关现已开放", 58), ("6", "大阶段", 58)):
        d.text((x, y), number, font=font(FONT_DIN, fnum), fill=WHITE)
        d.text((x, y + 72), label, font=font(FONT_M, 17), fill=MUTED)
        x += 230
    d.line([(96, 750), (720, 750)], fill=(139, 212, 223, 65), width=1)

    # a few small tags
    tags = ["冷锋", "准静止锋", "三城记", "海陆风", "山谷风"]
    tx = 96
    for tag in tags:
        f = font(FONT_M, 15)
        w = d.textlength(tag, font=f) + 26
        d.rounded_rectangle([tx, 790, tx + w, 826], radius=2, outline=(139, 212, 223, 55), fill=(8, 19, 26, 130))
        d.text((tx + 13, 797), tag, font=f, fill=(190, 218, 226))
        tx += w + 10

    tracked(d, (96, 930), "实机画面  /  第 19 关 · 三城记", font(FONT_M, 12), (139, 212, 223), tracking=1.0)
    bg.convert("RGB").save(OUT / "keyart-16x9.jpg", quality=95, subsampling=1)
    bg.convert("RGB").save(OUT / "keyart-16x9.png", optimize=True)


def make_features(icon: Image.Image) -> None:
    W, H = 1920, 1080
    bg = cover(RAW / "19-three-cities-running.png", (W, H), focus=(0.5, 0.5), zoom=1.06)
    bg = bg.filter(ImageFilter.GaussianBlur(7))
    bg = Image.alpha_composite(bg.convert("RGBA"), Image.new("RGBA", (W, H), (4, 10, 15, 165))).convert("RGB")
    bg = vignette(bg).convert("RGBA")
    d = ImageDraw.Draw(bg)

    top_brand(bg, d, icon)
    tracked(d, (170, 150), "核心玩法  /  CORE LOOP", font(FONT_M, 15), CYAN, tracking=2.2)
    shadow(d, (166, 182), "所有天气，都由三步推出来。", font(FONT_B, 52), WHITE)
    shadow(d, (170, 252), "先风，再垂直运动，最后降水。少一步，雨就不会发生。", font(FONT_M, 22), MUTED)

    specs = [
        ("01", "风场", "气压差驱动空气，湿区随风平移。", "P 梯度 → 风", CYAN),
        ("02", "上升 / 下沉", "低压抬升，高压抑制，决定 W。", "L 抬升 · H 下沉", GREEN),
        ("03", "降水", "只有上升且越过饱和，才成雨。", "W > 0 且过饱和", AMBER),
    ]
    x0, y0, cw, ch, gap = 170, 380, 500, 300, 40
    for i, (no, title, desc, foot, accent) in enumerate(specs):
        x = x0 + i * (cw + gap)
        d.rounded_rectangle([x, y0, x + cw, y0 + ch], radius=4, fill=(8, 17, 24, 225), outline=(46, 69, 82, 220), width=1)
        d.rectangle([x, y0, x + cw, y0 + 3], fill=accent)
        d.text((x + 30, y0 + 26), no, font=font(FONT_DIN, 46), fill=accent)
        d.text((x + 30, y0 + 92), title, font=font(FONT_B, 36), fill=WHITE)
        d.text((x + 30, y0 + 150), desc, font=font(FONT_M, 18), fill=MUTED)
        d.line([(x + 30, y0 + 218), (x + cw - 30, y0 + 218)], fill=(139, 212, 223, 35), width=1)
        tracked(d, (x + 30, y0 + 238), foot, font(FONT_M, 14), (139, 212, 223, 200), tracking=0.6)
        if i < 2:
            d.line([(x + cw + 8, y0 + ch / 2), (x + cw + gap - 8, y0 + ch / 2)], fill=(139, 212, 223, 100), width=1)
            d.line([(x + cw + gap - 18, y0 + ch / 2 - 7), (x + cw + gap - 8, y0 + ch / 2), (x + cw + gap - 18, y0 + ch / 2 + 7)], fill=(139, 212, 223, 100), width=1)

    draw_line = 760
    d.line([(170, draw_line), (1750, draw_line)], fill=(139, 212, 223, 55), width=1)
    tracked(d, (960, 796), "P 梯度  →  风  →  W  →  R", font(FONT_M, 20), (205, 228, 235), tracking=2.2, anchor="center")
    tracked(d, (960, 842), "你只负责气压差，剩下的交给大气。", font(FONT_M, 20), CYAN, tracking=1.4, anchor="center")
    tracked(d, (1824, 998), "实机画面 · 三步推演", font(FONT_M, 13), (139, 212, 223), tracking=0.8, anchor="right")
    bg.convert("RGB").save(OUT / "features-16x9.jpg", quality=95, subsampling=1)
    bg.convert("RGB").save(OUT / "features-16x9.png", optimize=True)


def make_levels(icon: Image.Image) -> None:
    W, H = 1920, 1080
    bg = cover(RAW / "05-campaign-all.png", (W, H), focus=(0.5, 0.22), zoom=1.1)
    bg = Image.alpha_composite(bg.convert("RGBA"), Image.new("RGBA", (W, H), (4, 10, 16, 112)))
    bg = Image.alpha_composite(bg, gradient_mask(W, H, 0.58))
    bg = Image.alpha_composite(bg, bottom_mask(W, H)).convert("RGB")
    bg = vignette(bg).convert("RGBA")
    d = ImageDraw.Draw(bg)

    top_brand(bg, d, icon)
    tracked(d, (96, 286), "全战役  /  CAMPAIGN", font(FONT_M, 15), CYAN, tracking=2.2)
    shadow(d, (88, 306), "72", font(FONT_DIN, 300), WHITE)
    shadow(d, (100, 610), "关战役", font(FONT_B, 52), WHITE)
    shadow(d, (100, 690), "25 关现已开放 · 6 大阶段 · 47 关开发中", font(FONT_M, 22), MUTED)
    draw_line = 760
    d.line([(100, draw_line), (830, draw_line)], fill=(139, 212, 223, 65), width=1)
    tracked(d, (100, 788), "从单张牌的基础系统，到三城同时成立。", font(FONT_M, 20), (205, 228, 235), tracking=0.8)
    tracked(d, (100, 830), "阶段一 1–13 · 阶段二 14–25", font(FONT_M, 16), (139, 212, 223), tracking=0.8)

    # stage breakdown panel (keeps the real level wall as a dim backdrop)
    px, py, pw, ph = 1030, 190, 770, 650
    d.rounded_rectangle([px, py, px + pw, py + ph], radius=5, fill=(7, 16, 23, 218), outline=(46, 69, 82, 210), width=1)
    d.rectangle([px, py, px + pw, py + 3], fill=(139, 212, 223, 210))
    tracked(d, (px + 30, py + 26), "6 大阶段  /  6 STAGES", font(FONT_M, 15), CYAN, tracking=1.6)
    d.line([(px + 30, py + 58), (px + pw - 30, py + 58)], fill=(139, 212, 223, 45), width=1)
    stages = [
        ("01", "基础系统", "13 关"),
        ("02", "基础组合", "12 关"),
        ("03", "四类系统", "4 关"),
        ("04", "高空环境与中尺度", "16 关"),
        ("05", "真实案例", "5 关"),
        ("06", "高难度综合", "22 关"),
    ]
    for i, (no, name, count) in enumerate(stages):
        ry = py + 86 + i * 82
        active = i < 2
        d.text((px + 30, ry), no, font=font(FONT_DIN, 24), fill=CYAN if active else (72, 94, 106))
        d.text((px + 82, ry - 2), name, font=font(FONT_B, 23), fill=WHITE if active else (126, 150, 162))
        d.text((px + pw - 30, ry), count, font=font(FONT_M, 15), fill=CYAN if active else (110, 134, 147), anchor="ra")
        if i < 5:
            d.line([(px + 30, ry + 54), (px + pw - 30, ry + 54)], fill=(139, 212, 223, 22), width=1)
    tracked(d, (px + pw - 30, py + ph - 40), "25 / 72 已开放", font(FONT_M, 13), (139, 212, 223), tracking=0.8, anchor="right")
    bg.convert("RGB").save(OUT / "levels-16x9.jpg", quality=95, subsampling=1)
    bg.convert("RGB").save(OUT / "levels-16x9.png", optimize=True)


def make_vertical(icon: Image.Image) -> None:
    W, H = 1080, 1920
    base = cover(RAW / "01-home.png", (W, H), focus=(0.5, 0.5), zoom=1.1)
    base = base.filter(ImageFilter.GaussianBlur(14))
    base = Image.alpha_composite(base.convert("RGBA"), Image.new("RGBA", (W, H), (4, 9, 14, 120))).convert("RGB")
    base = vignette(base).convert("RGBA")
    d = ImageDraw.Draw(base)

    # top icon + wordmark
    s = 94
    paste_icon(base, d, (W - s) // 2, 96, icon, s)
    d = ImageDraw.Draw(base)
    shadow(d, (W / 2, 218), "气象推演", font(FONT_B, 82), WHITE, anchor="ma")
    tracked(d, (W / 2, 322), "你只负责气压差，剩下的交给大气。", font(FONT_M, 21), MUTED, tracking=1.0, anchor="center")

    # screenshot window (map crop, real UI)
    map_shot = Image.open(RAW / "19-three-cities-result.png").convert("RGB")
    crop = map_shot.crop((520, 120, 3060, 2040))  # 2540x1920-ish map area
    crop = crop.resize((920, 696), Image.Resampling.LANCZOS)
    win = Image.new("RGBA", (940, 716), (7, 15, 21, 255))
    win.paste(crop, (10, 10))
    d = ImageDraw.Draw(win)
    d.rounded_rectangle([0, 0, 939, 715], radius=6, outline=(139, 212, 223, 85), width=1)
    base.alpha_composite(win, (70, 412))
    d = ImageDraw.Draw(base)
    tracked(d, (70, 1142), "实机画面  /  第 19 关 · 三城记", font(FONT_M, 14), (139, 212, 223), tracking=1.0)

    # feature rows
    rows = [
        ("01", "72 关战役", "6 大阶段，25 关现已开放"),
        ("02", "三步推演", "风 → 上升/下沉 → 降水"),
        ("03", "真实天气", "冷锋 / 海陆风 / 山谷风"),
    ]
    y = 1230
    for no, title, sub in rows:
        d.line([(80, y), (1000, y)], fill=(139, 212, 223, 38), width=1)
        d.text((80, y + 24), no, font=font(FONT_DIN, 30), fill=CYAN)
        d.text((150, y + 20), title, font=font(FONT_B, 30), fill=WHITE)
        d.text((150, y + 62), sub, font=font(FONT_M, 17), fill=MUTED)
        y += 128

    d.line([(80, 1660), (1000, 1660)], fill=(139, 212, 223, 55), width=1)
    tracked(d, (W / 2, 1690), "72 关战役 · 25 关现已开放", font(FONT_M, 18), (205, 228, 235), tracking=1.2, anchor="center")
    tracked(d, (W / 2, 1780), "极光视界工作室  /  METEOROLOGICAL DEDUCTION", font(FONT_M, 11), (110, 134, 147), tracking=1.2, anchor="center")
    base.convert("RGB").save(OUT / "poster-9x16.jpg", quality=95, subsampling=1)
    base.convert("RGB").save(OUT / "poster-9x16.png", optimize=True)


def make_contact_sheet() -> None:
    items = [
        ("keyart-16x9.jpg", "主视觉 16:9"),
        ("features-16x9.jpg", "核心玩法 16:9"),
        ("levels-16x9.jpg", "72 关战役 16:9"),
        ("poster-9x16.jpg", "竖版海报 9:16"),
    ]
    tw, th = 680, 383
    pad = 26
    label_h = 50
    sheet = Image.new("RGB", (2 * tw + pad * 3, 2 * (th + label_h) + pad * 3), "#081018")
    d = ImageDraw.Draw(sheet)
    f = font(FONT_M, 18)
    for i, (name, label) in enumerate(items):
        img = Image.open(OUT / name).convert("RGB")
        x = pad + (i % 2) * (tw + pad)
        y = pad + (i // 2) * (th + label_h + pad)
        if img.height > img.width * 1.2:
            # show the complete vertical poster, letterboxed
            fit = img.copy()
            fit.thumbnail((tw - 80, th - 30), Image.Resampling.LANCZOS)
            d.rectangle([x, y, x + tw - 1, y + th - 1], fill="#0b141b", outline="#263a48")
            sheet.paste(fit, (x + (tw - fit.width) // 2, y + (th - fit.height) // 2))
        else:
            scale = max(tw / img.width, th / img.height)
            resized = img.resize((round(img.width * scale), round(img.height * scale)), Image.Resampling.LANCZOS)
            left = (resized.width - tw) // 2
            top = (resized.height - th) // 2
            thumb = resized.crop((left, top, left + tw, top + th))
            sheet.paste(thumb, (x, y))
            d.rectangle([x, y, x + tw - 1, y + th - 1], outline="#263a48")
        d.text((x + 2, y + th + 12), label, font=f, fill="#b9d2dd")
    sheet.save(OUT / "00-contact-sheet.jpg", quality=94, subsampling=1)


def main() -> None:
    icon = Image.open(ICON).convert("RGB")
    # keyart-16x9 is owned by make_taptap_clean.py: TapTap's 16:9 promo may
    # contain nothing but the game name, no icon and no screenshot.
    make_features(icon)
    make_levels(icon)
    make_vertical(icon)
    make_contact_sheet()
    print("wrote promotional graphics to", OUT)


if __name__ == "__main__":
    main()
