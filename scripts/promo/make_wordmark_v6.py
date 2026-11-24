"""Pure name-only wordmark with an icy edge."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "deliverables" / "logo" / "concepts6"
OUT.mkdir(parents=True, exist_ok=True)

FONT = "C:/Windows/Fonts/NotoSansSC-VF.ttf"
W, H = 2560, 800
TEXT = "气象推演"
CYAN = (150, 220, 232)
NAVY = (6, 18, 26)


def layout(size=560, track=12):
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
        stops = [(0.0, (8, 23, 30)), (0.55, (12, 39, 48)), (1.0, (19, 63, 74))]
    else:
        stops = [(0.0, (255, 255, 255)), (0.52, (229, 248, 252)), (1.0, (143, 211, 228))]
    y0, y1 = bbox[1], bbox[3]
    rows = np.zeros((H, W, 3), dtype=np.uint8)
    for y in range(H):
        t = min(1.0, max(0.0, (y - y0) / max(1, y1 - y0)))
        for i in range(len(stops) - 1):
            a, ca = stops[i]
            b, cb = stops[i + 1]
            if a <= t <= b:
                k = (t - a) / max(1e-6, b - a)
                rows[y, :, :] = (np.array(ca) * (1 - k) + np.array(cb) * k).astype(np.uint8)
                break
        else:
            rows[y, :, :] = stops[-1][1]
    return Image.fromarray(rows)


def edge(mask, px=4):
    inner = mask.filter(ImageFilter.MinFilter(px * 2 + 1))
    a = np.array(mask, dtype=np.int16) - np.array(inner, dtype=np.int16)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def glow(mask, strength=0.22):
    g = mask.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(7))
    lay = Image.new("RGBA", (W, H), CYAN + (0,))
    lay.putalpha(g.point(lambda v: int(v * strength)))
    return lay


def shadow(mask, light=False):
    s = mask.filter(ImageFilter.GaussianBlur(5))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.paste((2, 9, 13, 110), (0, 6), s)
    return layer


def render(mask, bbox, light=False, edge_on=True):
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out = Image.alpha_composite(out, shadow(mask, light))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.paste(fill(bbox, light), (0, 0), mask)
    out = Image.alpha_composite(out, layer)
    if edge_on:
        e = edge(mask, 3)
        lay = Image.new("RGBA", (W, H), CYAN + (0,))
        lay.putalpha(e.point(lambda v: int(v * (0.55 if light else 0.80))))
        out = Image.alpha_composite(out, lay)
    out = Image.alpha_composite(glow(mask, 0.08 if light else 0.16), out)
    return out


def preview(rgba, path, bg):
    im = Image.new("RGB", (W, H), bg).convert("RGBA")
    im = Image.alpha_composite(im, rgba).convert("RGB")
    im.resize((1280, 400), Image.LANCZOS).save(path, quality=95)


if __name__ == "__main__":
    mask, bbox = layout()
    dark = render(mask, bbox, False, True)
    dark_plain = render(mask, bbox, False, False)
    light = render(mask, bbox, True, True)
    for name, img in (("edge", dark), ("plain", dark_plain), ("dark-edge", light)):
        img.resize((1280, 400), Image.LANCZOS).save(OUT / f"{name}.png")
    preview(dark, OUT / "edge-on-dark.jpg", NAVY)
    preview(dark_plain, OUT / "plain-on-dark.jpg", NAVY)
    preview(light, OUT / "dark-edge-on-light.jpg", (246, 250, 251))
    print("wrote", OUT)
