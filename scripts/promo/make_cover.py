"""Create a 16:9 cover / poster from the three-cities gameplay capture."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "capture" / "raw"
OUT = ROOT / "deliverables"
OUT.mkdir(parents=True, exist_ok=True)
W, H = 1920, 1080

FONT_BOLD = "C:/Windows/Fonts/Noto Sans SC Bold (TrueType).otf"
FONT_MED = "C:/Windows/Fonts/Noto Sans SC Medium (TrueType).otf"
FONT_MONO = "C:/Windows/Fonts/CascadiaMono.ttf"

WHITE = (244, 251, 252)
MUTED = (166, 190, 203)
CYAN = (139, 212, 223)
DIM = (105, 129, 142)


def tracked(draw, xy, text, font, fill, tracking=0.0, anchor="left"):
    widths = [draw.textlength(ch, font=font) for ch in text]
    total = sum(widths) + tracking * max(0, len(text) - 1)
    x, y = xy
    if anchor == "center":
        x -= total / 2
    elif anchor == "right":
        x -= total
    for ch, width in zip(text, widths):
        draw.text((x, y), ch, font=font, fill=fill)
        x += width + tracking


def shadow(draw, xy, text, font, fill, anchor="la"):
    draw.text((xy[0] + 1, xy[1] + 3), text, font=font, fill=(0, 0, 0, 190), anchor=anchor)
    draw.text(xy, text, font=font, fill=fill, anchor=anchor)


src = Image.open(RAW / "19-three-cities-clean.png").convert("RGB")
# crop a 16:9 window around the three-city map, then downscale
cw = src.height * 16 / 9
cx = src.width * 0.53
left = min(max(cx - cw / 2, 0), src.width - cw)
bg = src.crop((left, 0, left + cw, src.height)).resize((W, H), Image.Resampling.LANCZOS)

# left-side cinematic shade
yy, xx = np.mgrid[0:H, 0:W]
fade = np.clip((xx - 610) / 440, 0, 1)
fade = fade * fade * (3 - 2 * fade)
left_shade = 250 * (1 - fade)
bottom_shade = 210 * np.clip((yy - 620) / 460, 0, 1) ** 1.4
alpha = np.maximum(left_shade, bottom_shade).astype(np.uint8)
shade = np.zeros((H, W, 4), dtype=np.uint8)
shade[..., 3] = alpha
bg = Image.alpha_composite(bg.convert("RGBA"), Image.fromarray(shade, "RGBA")).convert("RGB")

# vignette
r = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
v = 1 - 0.24 * np.clip((r - 0.45) / 1.0, 0, 1) ** 1.4
bg = Image.fromarray(np.clip(np.asarray(bg, dtype=np.float32) * v[..., None], 0, 255).astype(np.uint8))

draw = ImageDraw.Draw(bg)
f_kicker = ImageFont.truetype(FONT_MED, 16)
f_title = ImageFont.truetype(FONT_BOLD, 118)
f_tag = ImageFont.truetype(FONT_MED, 26)
f_stat = ImageFont.truetype(FONT_MED, 17)
f_gen = ImageFont.truetype(FONT_MED, 14)
f_mono = ImageFont.truetype(FONT_MONO, 13)

tracked(draw, (104, 286), "WEATHER SYSTEM  /  连续天气图 · 交互推演", f_kicker, CYAN, tracking=2.2)
draw.rectangle([104, 322, 164, 325], fill=CYAN)
shadow(draw, (100, 344), "气象推演", f_title, WHITE)
shadow(draw, (104, 500), "你只负责气压差，剩下的交给大气。", f_tag, MUTED, anchor="la")

draw.line([(104, 590), (760, 590)], fill=(139, 212, 223, 70), width=1)
shadow(draw, (104, 614), "72 关战役    ·    25 关现已开放", f_stat, (205, 228, 235), anchor="la")
tracked(draw, (104, 660), "冷锋 / 准静止锋 / 三城记 / 海陆风 / 山谷风", f_gen, (139, 212, 223), tracking=0.8)

shadow(draw, (104, 990), "极光视界工作室", f_gen, DIM, anchor="la")
tracked(draw, (W - 104, 990), "REAL GAMEPLAY", f_mono, (139, 212, 223), tracking=2.0, anchor="right")

bg.save(OUT / "cover-16x9.jpg", quality=94, subsampling=1)
bg.save(OUT / "cover-16x9.png", optimize=True)
print("wrote cover")
