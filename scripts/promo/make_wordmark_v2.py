"""Wordmark exploration v2: name-only, chart-derived cuts."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "deliverables" / "logo" / "concepts2"
OUT.mkdir(parents=True, exist_ok=True)

SANS = "C:/Windows/Fonts/NotoSansSC-VF.ttf"
SERIF = "C:/Windows/Fonts/Source Han Serif SC Heavy (TrueType).ttf"
W, H = 2560, 800
TEXT = "气象推演"
NAVY = (6, 18, 26)
CYAN = (150, 220, 232)


def font(path, size, weight=None):
    f = ImageFont.truetype(path, size)
    if weight:
        try:
            f.set_variation_by_name(weight)
        except Exception:
            pass
    return f


def layout(path, size, track, weight=None):
    f = font(path, size, weight)
    ascent, descent = f.getmetrics()
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    adv = [f.getlength(ch) for ch in TEXT]
    total = sum(adv) + track * (len(TEXT) - 1)
    x = (W - total) / 2
    baseline = (H + ascent - descent) / 2
    for ch, a in zip(TEXT, adv):
        d.text((x, baseline), ch, font=f, fill=255, anchor="ls")
        x += a + track
    return m, m.getbbox()


def wave(x0, x1, y, amp, period, phase, n=300):
    xs = np.linspace(x0, x1, n)
    ys = y + amp * np.sin((xs - x0) / period * 2 * np.pi + phase)
    return list(zip(xs.tolist(), ys.tolist()))


def band_mask(pts, width):
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    d.line(pts, fill=255, width=width, joint="curve")
    return m


def fade(mask, px=110):
    a = np.array(mask, dtype=np.float32) / 255
    ramp = np.ones(W, dtype=np.float32)
    ramp[:px] = np.linspace(0.05, 1, px)
    ramp[-px:] = np.linspace(1, 0.05, px)
    return Image.fromarray((a * ramp[None, :] * 255).astype(np.uint8))


def fill_image(bbox):
    top = np.array([255, 255, 255], dtype=np.float32)
    bottom = np.array([190, 235, 244], dtype=np.float32)
    y0, y1 = bbox[1], bbox[3]
    rows = []
    for y in range(H):
        t = min(1.0, max(0.0, (y - y0) / max(1, y1 - y0)))
        rows.append(top * (1 - t) + bottom * t)
    return Image.fromarray(np.tile(np.array(rows, dtype=np.uint8)[:, None, :], (1, W, 1)))


def glow(mask, strength=0.18):
    g = mask.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(7))
    layer = Image.new("RGBA", (W, H), CYAN + (0,))
    layer.putalpha(g.point(lambda v: int(v * strength)))
    return layer


def render(mask, bbox, cuts, shift=None, rings=False):
    # Optional shear of the top half at the first cut.
    m = mask
    if shift is not None:
        y = shift
        top = m.crop((0, 0, W, y))
        bottom = m.crop((0, y, W, H))
        m = Image.new("L", (W, H), 0)
        m.paste(top, (14, 0))
        m.paste(bottom, (0, y))

    for pts, gap in cuts:
        m.paste(0, (0, 0), fade(band_mask(pts, gap)))

    # Rings clipped inside the glyphs.
    texture = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if rings:
        d = ImageDraw.Draw(texture)
        cx, cy = W / 2, H / 2 + 20
        for r in (330, 470, 620, 790, 980):
            for k in range(3):
                rr = r + k * 22
                d.ellipse((cx - rr, cy - rr * 0.62, cx + rr, cy + rr * 0.62),
                          outline=CYAN + (175,), width=4)

    fill = fill_image(bbox)
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.paste(fill, (0, 0), m)
    if rings:
        clip = texture.copy()
        a = np.array(clip.getchannel("A"), dtype=np.float32)
        a *= np.array(m, dtype=np.float32) / 255
        clip.putalpha(Image.fromarray(a.astype(np.uint8)))
        out = Image.alpha_composite(out, clip)

    out = Image.alpha_composite(glow(m), out)

    for pts, _ in cuts:
        line = fade(band_mask(pts, 5))
        layer = Image.new("RGBA", (W, H), CYAN + (0,))
        layer.putalpha(line.point(lambda v: int(v * 0.95)))
        out = Image.alpha_composite(out, layer)

    return out


def preview(rgba, path, bg=NAVY):
    im = Image.new("RGB", (W, H), bg).convert("RGBA")
    im = Image.alpha_composite(im, rgba).convert("RGB")
    im.resize((1280, 400), Image.LANCZOS).save(path, quality=95)


if __name__ == "__main__":
    # Geometry for the strong cut through the middle.
    mask_b, bbox_b = layout(SANS, 540, 18, "Black")
    y_main = bbox_b[1] + (bbox_b[3] - bbox_b[1]) * 0.54
    main = wave(bbox_b[0] - 40, bbox_b[2] + 40, y_main, 24, 980, 0.4)
    y_sub = bbox_b[1] + (bbox_b[3] - bbox_b[1]) * 0.82
    sub = wave(bbox_b[0] - 40, bbox_b[2] + 40, y_sub, 12, 780, 2.2)

    variants = {
        "black-clean": render(mask_b, bbox_b, []),
        "black-cut": render(mask_b, bbox_b, [(main, 24)]),
        "black-shear": render(mask_b, bbox_b, [(main, 24), (sub, 14)], shift=int(y_main)),
        "black-rings": render(mask_b, bbox_b, [(sub, 14)], rings=True),
    }

    mask_s, bbox_s = layout(SERIF, 560, 24, None)
    y_s = bbox_s[1] + (bbox_s[3] - bbox_s[1]) * 0.56
    line_s = wave(bbox_s[0] - 40, bbox_s[2] + 40, y_s, 20, 1000, 0.8)
    variants["serif-cut"] = render(mask_s, bbox_s, [(line_s, 20)])

    for name, rgba in variants.items():
        rgba.resize((1280, 400), Image.LANCZOS).save(OUT / f"{name}.png")
        preview(rgba, OUT / f"{name}-dark.jpg")
    print("wrote", OUT)
