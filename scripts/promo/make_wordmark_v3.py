"""Wordmark v3: clean name-only with a chart-derived underline / rim."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "deliverables" / "logo" / "concepts3"
OUT.mkdir(parents=True, exist_ok=True)

FONT = "C:/Windows/Fonts/NotoSansSC-VF.ttf"
W, H = 2560, 800
TEXT = "气象推演"
NAVY = (6, 18, 26)
CYAN = (150, 220, 232)


def layout(size=540, track=18, weight="Black"):
    f = ImageFont.truetype(FONT, size)
    f.set_variation_by_name(weight)
    ascent, descent = f.getmetrics()
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    adv = [f.getlength(ch) for ch in TEXT]
    total = sum(adv) + track * (len(TEXT) - 1)
    x = (W - total) / 2
    base = (H + ascent - descent) / 2
    for ch, a in zip(TEXT, adv):
        d.text((x, base), ch, font=f, fill=255, anchor="ls")
        x += a + track
    return m, m.getbbox()


def fill(bbox):
    top = np.array([255, 255, 255], dtype=np.float32)
    bot = np.array([188, 234, 244], dtype=np.float32)
    y0, y1 = bbox[1], bbox[3]
    rows = np.zeros((H, W, 3), dtype=np.uint8)
    for y in range(H):
        t = min(1.0, max(0.0, (y - y0) / max(1, y1 - y0)))
        rows[y, :, :] = (top * (1 - t) + bot * t).astype(np.uint8)
    return Image.fromarray(rows)


def shifted(mask, dx=0, dy=0):
    out = Image.new("L", (W, H), 0)
    out.paste(mask, (dx, dy))
    return out


def bottom_rim(mask, px=4):
    up = shifted(mask, 0, -px)
    a = np.array(mask, dtype=np.int16) - np.array(up, dtype=np.int16)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def wave(x0, x1, y, amp, period, phase, n=300):
    xs = np.linspace(x0, x1, n)
    ys = y + amp * np.sin((xs - x0) / period * 2 * np.pi + phase)
    return list(zip(xs.tolist(), ys.tolist()))


def fade_line(mask, px=100):
    a = np.array(mask, dtype=np.float32) / 255
    ramp = np.ones(W, dtype=np.float32)
    ramp[:px] = np.linspace(0, 1, px)
    ramp[-px:] = np.linspace(1, 0, px)
    return Image.fromarray((a * ramp[None, :] * 255).astype(np.uint8))


def glow(mask, strength=0.15):
    g = mask.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(6))
    layer = Image.new("RGBA", (W, H), CYAN + (0,))
    layer.putalpha(g.point(lambda v: int(v * strength)))
    return layer


def render(mask, bbox, underline=False, teeth=False, rim=True):
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.paste(fill(bbox), (0, 0), mask)
    out = Image.alpha_composite(glow(mask), out)

    if rim:
        r = bottom_rim(mask, 4)
        lay = Image.new("RGBA", (W, H), CYAN + (0,))
        lay.putalpha(r.point(lambda v: int(v * 0.62)))
        out = Image.alpha_composite(out, lay)

    if underline or teeth:
        y = bbox[3] + 54
        pts = wave(bbox[0] - 30, bbox[2] + 30, y, 9, 980, 0.5)
        m = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(m)
        d.line(pts, fill=255, width=4, joint="curve")
        if teeth:
            # Place cold-front triangles on the contour at three positions.
            for frac in (0.18, 0.48, 0.78):
                cx = bbox[0] + (bbox[2] - bbox[0]) * frac
                cy = y + 9 * np.sin((cx - (bbox[0] - 30)) / 980 * 2 * np.pi + 0.5)
                d.polygon([(cx - 16, cy - 2), (cx + 16, cy - 2), (cx, cy + 30)], fill=255)
        m = fade_line(m, 90)
        lay = Image.new("RGBA", (W, H), CYAN + (0,))
        lay.putalpha(m.point(lambda v: int(v * 0.88)))
        out = Image.alpha_composite(out, lay)

    return out


def preview(rgba, path, bg=NAVY):
    im = Image.new("RGB", (W, H), bg).convert("RGBA")
    im = Image.alpha_composite(im, rgba).convert("RGB")
    im.resize((1280, 400), Image.LANCZOS).save(path, quality=95)


if __name__ == "__main__":
    mask, bbox = layout()
    variants = {
        "rim": render(mask, bbox, rim=True),
        "underline": render(mask, bbox, underline=True, rim=True),
        "front": render(mask, bbox, underline=True, teeth=True, rim=True),
    }
    for name, rgba in variants.items():
        rgba.resize((1280, 400), Image.LANCZOS).save(OUT / f"{name}.png")
        preview(rgba, OUT / f"{name}-dark.jpg")
    print("wrote", OUT)
