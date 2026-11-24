"""Wordmark v4: name-only with a close cold-front baseline."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "deliverables" / "logo" / "concepts4"
OUT.mkdir(parents=True, exist_ok=True)

FONT = "C:/Windows/Fonts/NotoSansSC-VF.ttf"
W, H = 2560, 800
TEXT = "气象推演"
NAVY = (6, 18, 26)
CYAN = (150, 220, 232)


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


def fill(bbox):
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


def fade(mask, px=90):
    a = np.array(mask, dtype=np.float32) / 255
    r = np.ones(W, dtype=np.float32)
    r[:px] = np.linspace(0, 1, px)
    r[-px:] = np.linspace(1, 0, px)
    return Image.fromarray((a * r[None, :] * 255).astype(np.uint8))


def glow(mask, strength=0.16):
    g = mask.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(6))
    lay = Image.new("RGBA", (W, H), CYAN + (0,))
    lay.putalpha(g.point(lambda v: int(v * strength)))
    return lay


def render(mask, bbox, teeth=True, backdrop=False):
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if backdrop:
        bd = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(bd)
        for frac, amp, phase, alpha in ((0.28, 22, 0.2, 42), (0.66, 16, 2.1, 34)):
            y = bbox[1] + (bbox[3] - bbox[1]) * frac
            d.line(wave(bbox[0] - 120, bbox[2] + 120, y, amp, 1100, phase),
                   fill=CYAN + (alpha,), width=3, joint="curve")
        out = Image.alpha_composite(out, bd)

    out.alpha_composite(Image.new("RGBA", (W, H), (0, 0, 0, 0)))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.paste(fill(bbox), (0, 0), mask)
    out = Image.alpha_composite(out, layer)
    out = Image.alpha_composite(glow(mask), out)

    r = rim(mask, 4)
    lay = Image.new("RGBA", (W, H), CYAN + (0,))
    lay.putalpha(r.point(lambda v: int(v * 0.70)))
    out = Image.alpha_composite(out, lay)

    # Cold-front baseline, close to the feet of the characters.
    y = bbox[3] + 18
    pts = wave(bbox[0] - 26, bbox[2] + 26, y, 7, 1040, 0.4)
    line = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(line)
    d.line(pts, fill=255, width=4, joint="curve")
    if teeth:
        for frac in (0.16, 0.45, 0.74):
            cx = bbox[0] + (bbox[2] - bbox[0]) * frac
            cy = y + 7 * np.sin((cx - (bbox[0] - 26)) / 1040 * 2 * np.pi + 0.4)
            d.polygon([(cx - 17, cy - 3), (cx + 17, cy - 3), (cx, cy + 27)], fill=255)
    line = fade(line, 70)
    lay = Image.new("RGBA", (W, H), CYAN + (0,))
    lay.putalpha(line.point(lambda v: int(v * 0.86)))
    out = Image.alpha_composite(out, lay)
    return out


def preview(rgba, path, bg=NAVY):
    im = Image.new("RGB", (W, H), bg).convert("RGBA")
    im = Image.alpha_composite(im, rgba).convert("RGB")
    im.resize((1280, 400), Image.LANCZOS).save(path, quality=95)


if __name__ == "__main__":
    mask, bbox = layout()
    print("bbox", bbox, "text width", bbox[2] - bbox[0])
    variants = {
        "front-close": render(mask, bbox, teeth=True),
        "line-close": render(mask, bbox, teeth=False),
        "front-backdrop": render(mask, bbox, teeth=True, backdrop=True),
    }
    for name, rgba in variants.items():
        rgba.resize((1280, 400), Image.LANCZOS).save(OUT / f"{name}.png")
        preview(rgba, OUT / f"{name}-dark.jpg")
    print("wrote", OUT)
