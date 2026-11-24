from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "capture" / "final-demo-40.jpg"
OUT = ROOT / "deliverables" / "demo-cover-16x9.jpg"
FONT_B = "C:/Windows/Fonts/Noto Sans SC Bold (TrueType).otf"
FONT_M = "C:/Windows/Fonts/Noto Sans SC Medium (TrueType).otf"
WHITE = (244, 251, 252)
MUTED = (166, 190, 203)
CYAN = (139, 212, 223)
W, H = 1920, 1080

bg = Image.open(SRC).convert("RGB")
yy, xx = np.mgrid[0:H, 0:W]
fade = np.clip((xx - 600) / 500, 0, 1)
fade = fade * fade * (3 - 2 * fade)
alpha = (246 * (1 - fade)).astype(np.uint8)
shade = np.zeros((H, W, 4), dtype=np.uint8)
shade[..., 3] = alpha
bg = Image.alpha_composite(bg.convert("RGBA"), Image.fromarray(shade, "RGBA")).convert("RGB")

draw = ImageDraw.Draw(bg)
f_kicker = ImageFont.truetype(FONT_M, 16)
f_title = ImageFont.truetype(FONT_B, 106)
f_sub = ImageFont.truetype(FONT_M, 26)
f_small = ImageFont.truetype(FONT_M, 16)

draw.text((104, 282), "REAL GAMEPLAY  /  真实操作 · 无跳剪", font=f_kicker, fill=CYAN)
draw.rectangle([104, 318, 164, 321], fill=CYAN)
draw.text((100, 340), "实机演示", font=f_title, fill=WHITE)
draw.text((104, 492), "第 19 关 三城记  ·  第 24 关 海陆风", font=f_sub, fill=MUTED)
draw.line([(104, 566), (700, 566)], fill=(139, 212, 223, 70), width=1)
draw.text((104, 592), "鼠标放置 · 悬停数据 · 三步推演 · 目标达成", font=f_small, fill=(205, 228, 235))
draw.text((104, 990), "气象推演  /  72 关战役 · 25 关现已开放", font=f_small, fill=(116, 140, 153))
bg.save(OUT, quality=94, subsampling=1)
print("wrote", OUT)
