"""Explore wordmark directions for 气象推演 (name only, no icon)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "deliverables" / "logo" / "concepts"
OUT.mkdir(parents=True, exist_ok=True)
FONT = "C:/Windows/Fonts/NotoSansSC-VF.ttf"

W, H = 2560, 800
TEXT = "气象推演"
SIZE = 540
TRACK = 26
NAVY = (6, 18, 26)
CYAN = (150, 220, 232)
WHITE = (245, 251, 253)


def font(size=SIZE, weight="Bold"):
    f = ImageFont.truetype(FONT, size)
    f.set_variation_by_name(weight)
    return f


def text_mask(text=TEXT, size=SIZE, track=TRACK, weight="Bold"):
    f = font(size, weight)
    ascent, descent = f.getmetrics()
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    advances = [f.getlength(ch) for ch in text]
    total = sum(advances) + track * (len(text) - 1)
    x = (W - total) / 2
    baseline = (H + ascent - descent) / 2
    for ch, adv in zip(text, advances):
        d.text((x, baseline), ch, font=f, fill=255, anchor="ls")
        x += adv + track
    bbox = m.getbbox()
    return m, bbox


def hline_mask(pts, width):
    layer = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(layer)
    d.line(pts, fill=255, width=width, joint="curve")
    return layer


def wave(x0, x1, y0, amp, period, phase=0.0, n=260):
    xs = np.linspace(x0, x1, n)
    ys = y0 + amp * np.sin((xs - x0) / period * 2 * np.pi + phase)
    return list(zip(xs.tolist(), ys.tolist()))


def end_fade(width):
    """Horizontal alpha ramp, soft at both ends."""
    a = np.ones((H, W), dtype=np.float32)
    ramp = 90
    a[:, :ramp] = np.linspace(0.15, 1, ramp)[None, :]
    a[:, -ramp:] = np.linspace(1, 0.15, ramp)[None, :]
    return Image.fromarray((a * 255).astype(np.uint8))


def make_fill(bbox, top=(255, 255, 255), bottom=(198, 238, 246)):
    y0, y1 = bbox[1], bbox[3]
    grad = np.zeros((H, W, 3), dtype=np.uint8)
    for y in range(H):
        t = min(1, max(0, (y - y0) / max(1, y1 - y0)))
        col = [round(top[i] * (1 - t) + bottom[i] * t) for i in range(3)]
        grad[y, :, :] = col
    return Image.fromarray(grad)


def compose(mask, bbox, variant):
    # Base fill + a subtle cyan keyline/glow.
    fill = make_fill(bbox)
    rgba = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rgba.paste(fill, (0, 0), mask)

    # Outer ion glow: dilate mask, cyan at low alpha.
    glow = mask.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(5))
    glow_rgba = Image.new("RGBA", (W, H), CYAN + (0,))
    glow_rgba.putalpha(glow.point(lambda v: int(v * 0.20)))
    rgba = Image.alpha_composite(glow_rgba, rgba)

    if variant == "clean":
        pass

    if variant in ("isobar", "shear"):
        # Two weather-chart contours carved through the wordmark.
        specs = [(0.40, 18, 1000, 0.6, 7), (0.73, 12, 800, 2.1, 5)]
        if variant == "shear":
            specs = [(0.53, 16, 1000, 0.9, 9), (0.80, 10, 760, 2.4, 4)]

        for frac, amp, period, phase, gap in specs:
            y = bbox[1] + (bbox[3] - bbox[1]) * frac
            pts = wave(bbox[0] - 34, bbox[2] + 34, y, amp, period, phase)
            band = hline_mask(pts, gap)
            band = Image.composite(band, Image.new("L", (W, H), 0), end_fade(W))

            # Carve a transparent channel through the glyphs.
            cut = mask.copy()
            cut.paste(0, (0, 0), band)
            rgba = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            rgba.paste(fill, (0, 0), cut)
            rgba = Image.alpha_composite(glow_rgba, rgba)

            # A thin cyan contour floats in the channel.
            line = hline_mask(pts, 3)
            line = Image.composite(line, Image.new("L", (W, H), 0), end_fade(W))
            contour = Image.new("RGBA", (W, H), CYAN + (0,))
            contour.putalpha(line.point(lambda v: int(v * 0.92)))
            rgba = Image.alpha_composite(rgba, contour)

        if variant == "shear":
            # Split at the main contour and shear the upper half.
            y = int(bbox[1] + (bbox[3] - bbox[1]) * 0.53)
            top = rgba.crop((0, 0, W, y))
            bottom = rgba.crop((0, y, W, H))
            shifted = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            shifted.alpha_composite(top, (8, 0))
            shifted.alpha_composite(bottom, (0, y))
            rgba = shifted

    return rgba


def preview(rgba, bg, path):
    im = Image.new("RGB", (W, H), bg)
    im = Image.alpha_composite(im.convert("RGBA"), rgba).convert("RGB")
    im = im.resize((1280, 400), Image.LANCZOS)
    im.save(path, quality=95)


if __name__ == "__main__":
    mask, bbox = text_mask()
    print("bbox", bbox)
    for variant in ("clean", "isobar", "shear"):
        rgba = compose(mask, bbox, variant)
        rgba.resize((1280, 400), Image.LANCZOS).save(OUT / f"wordmark-{variant}.png")
        preview(rgba, NAVY, OUT / f"preview-{variant}-dark.jpg")
        preview(rgba, (245, 249, 250), OUT / f"preview-{variant}-light.jpg")
    print("wrote", OUT)
