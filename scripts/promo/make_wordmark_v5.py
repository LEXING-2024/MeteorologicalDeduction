"""Final wordmark direction: name-only + a restrained cold-front baseline."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "deliverables" / "logo" / "concepts5"
OUT.mkdir(parents=True, exist_ok=True)

FONT = "C:/Windows/Fonts/NotoSansSC-VF.ttf"
W, H = 2560, 800
TEXT = "气象推演"
CYAN = (150, 220, 232)
NAVY = (6, 18, 26)


def layout(size=560, track=10):
    f = ImageFont.truetype(FONT, size)
    f.set_variation_by_name("Black")
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


def fill(bbox, light=False):
    if light:
        top = np.array([9, 26, 34], dtype=np.float32)
        bot = np.array([17, 54, 64], dtype=np.float32)
    else:
        top = np.array([255, 255, 255], dtype=np.float32)
        bot = np.array([190, 235, 245], dtype=np.float32)
    y0, y1 = bbox[1], bbox[3]
    rows = np.zeros((H, W, 3), dtype=np.uint8)
    for y in range(H):
        t = min(1.0, max(0.0, (y - y0) / max(1, y1 - y0)))
        rows[y, :, :] = (top * (1 - t) + bot * t).astype(np.uint8)
    return Image.fromarray(rows)


def shift(mask, dx=0, dy=0):
    out = Image.new("L", (W, H), 0)
    out.paste(mask, (dx, dy))
    return out


def rim(mask, px=4):
    diff = np.array(mask, dtype=np.int16) - np.array(shift(mask, 0, -px), dtype=np.int16)
    return Image.fromarray(np.clip(diff, 0, 255).astype(np.uint8))


def wave(x0, x1, y, amp, period, phase, n=320):
    xs = np.linspace(x0, x1, n)
    ys = y + amp * np.sin((xs - x0) / period * 2 * np.pi + phase)
    return list(zip(xs.tolist(), ys.tolist()))


def fade(mask, px=80):
    a = np.array(mask, dtype=np.float32) / 255
    r = np.ones(W, dtype=np.float32)
    r[:px] = np.linspace(0.05, 1, px)
    r[-px:] = np.linspace(1, 0.05, px)
    return Image.fromarray((a * r[None, :] * 255).astype(np.uint8))


def glow(mask, strength=0.14):
    g = mask.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(6))
    lay = Image.new("RGBA", (W, H), CYAN + (0,))
    lay.putalpha(g.point(lambda v: int(v * strength)))
    return lay


def render(mask, bbox, light=False):
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.paste(fill(bbox, light), (0, 0), mask)
    out = Image.alpha_composite(glow(mask, 0.10 if light else 0.14), out)

    r = rim(mask, 4)
    lay = Image.new("RGBA", (W, H), CYAN + (0,))
    lay.putalpha(r.point(lambda v: int(v * (0.42 if light else 0.65))))
    out = Image.alpha_composite(out, lay)

    # Cold-front baseline: one line, two deliberate teeth.
    y = bbox[3] + 26
    pts = wave(bbox[0] - 24, bbox[2] + 24, y, 6, 1080, 0.5)
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    d.line(pts, fill=255, width=4, joint="curve")
    for frac in (0.26, 0.72):
        cx = bbox[0] + (bbox[2] - bbox[0]) * frac
        cy = y + 6 * np.sin((cx - (bbox[0] - 24)) / 1080 * 2 * np.pi + 0.5)
        d.polygon([(cx - 21, cy - 3), (cx + 21, cy - 3), (cx, cy + 31)], fill=255)
    m = fade(m, 64)
    lay = Image.new("RGBA", (W, H), CYAN + (0,))
    lay.putalpha(m.point(lambda v: int(v * (0.62 if light else 0.82))))
    out = Image.alpha_composite(out, lay)
    return out


def preview(rgba, path, bg):
    im = Image.new("RGB", (W, H), bg).convert("RGBA")
    im = Image.alpha_composite(im, rgba).convert("RGB")
    im.resize((1280, 400), Image.LANCZOS).save(path, quality=95)


if __name__ == "__main__":
    mask, bbox = layout()
    print("bbox", bbox, "width", bbox[2] - bbox[0])
    dark = render(mask, bbox, False)
    light = render(mask, bbox, True)
    dark.resize((1280, 400), Image.LANCZOS).save(OUT / "wordmark-light.png")
    light.resize((1280, 400), Image.LANCZOS).save(OUT / "wordmark-dark.png")
    preview(dark, OUT / "preview-on-dark.jpg", NAVY)
    preview(dark, OUT / "preview-on-light.jpg", (246, 250, 251))
    preview(light, OUT / "preview-dark-on-light.jpg", (246, 250, 251))
    print("wrote", OUT)
