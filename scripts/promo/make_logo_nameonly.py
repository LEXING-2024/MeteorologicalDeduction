"""Name-only wordmark for 气象推演.

The icon keeps the H / isobars; the logo is the game name alone, with the same
icy edge and chart-cyan light as the in-game title.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "deliverables" / "logo"
FONT = "C:/Windows/Fonts/NotoSansSC-VF.ttf"
CYAN = (150, 220, 232)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(FONT, size)
    f.set_variation_by_name("Black")
    return f


def draw_line(text: str, f: ImageFont.FreeTypeFont, tracking: list[int]) -> Image.Image:
    """One line of text, per-pair optical tracking, tight glyph bbox."""
    adv = [f.getlength(ch) for ch in text]
    total = sum(adv) + sum(tracking)
    pad = 80
    w = int(total) + pad * 2
    h = int(f.size * 1.6)
    m = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(m)
    ascent, descent = f.getmetrics()
    baseline = (h + ascent - descent) / 2
    x = pad
    for i, (ch, a) in enumerate(zip(text, adv)):
        d.text((x, baseline), ch, font=f, fill=255, anchor="ls")
        x += a
        if i < len(tracking):
            x += tracking[i]
    return m


def fill_image(bbox, size, light=False):
    if light:
        stops = [(0.0, (8, 23, 30)), (0.55, (12, 39, 48)), (1.0, (19, 63, 74))]
    else:
        stops = [(0.0, (255, 255, 255)), (0.52, (229, 248, 252)), (1.0, (143, 211, 228))]
    w, h = size
    y0, y1 = bbox[1], bbox[3]
    rows = np.zeros((h, w, 3), dtype=np.uint8)
    for y in range(h):
        t = min(1.0, max(0.0, (y - y0) / max(1, y1 - y0)))
        col = np.array(stops[-1][1], dtype=np.float32)
        for i in range(len(stops) - 1):
            a, ca = stops[i]
            b, cb = stops[i + 1]
            if a <= t <= b:
                k = (t - a) / max(1e-6, b - a)
                col = np.array(ca, dtype=np.float32) * (1 - k) + np.array(cb, dtype=np.float32) * k
                break
        rows[y, :, :] = col.astype(np.uint8)
    return Image.fromarray(rows)


def edge(mask, px=4):
    inner = mask.filter(ImageFilter.MinFilter(px * 2 + 1))
    a = np.array(mask, dtype=np.int16) - np.array(inner, dtype=np.int16)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def render(mask, light=False, edge_px=4):
    w, h = mask.size
    bbox = mask.getbbox()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    layer.paste(fill_image(bbox, (w, h), light), (0, 0), mask)
    out = Image.alpha_composite(out, layer)

    # Cyan inner edge.
    e = edge(mask, edge_px)
    lay = Image.new("RGBA", (w, h), CYAN + (0,))
    lay.putalpha(e.point(lambda v: int(v * (0.50 if light else 0.78))))
    out = Image.alpha_composite(out, lay)

    # Soft chart-light.
    g = mask.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(7))
    glow = Image.new("RGBA", (w, h), CYAN + (0,))
    glow.putalpha(g.point(lambda v: int(v * (0.06 if light else 0.13))))
    out = Image.alpha_composite(glow, out)
    return out


def crop(im):
    b = im.getbbox()
    pad = 28
    return im.crop((max(0, b[0] - pad), max(0, b[1] - pad), min(im.width, b[2] + pad), min(im.height, b[3] + pad)))


def horizontal():
    f = load_font(600)
    line = draw_line("气象推演", f, [10, 15, 11])
    # Slight horizontal compression keeps the logotype dense.
    line = line.resize((int(line.width * 0.985), line.height), Image.LANCZOS)
    img = render(line)
    img = crop(img)
    canvas = Image.new("RGBA", (2560, 800), (0, 0, 0, 0))
    canvas.alpha_composite(img, ((2560 - img.width) // 2, (800 - img.height) // 2))
    return canvas.resize((1280, 400), Image.LANCZOS)


def stacked():
    f = load_font(540)
    line1 = draw_line("气象", f, [14])
    line2 = draw_line("推演", f, [14])
    top = render(line1)
    bottom = render(line2)
    top = top.crop(top.getbbox())
    bottom = bottom.crop(bottom.getbbox())
    w = max(top.width, bottom.width)
    gap = 44
    h = top.height + bottom.height + gap
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.alpha_composite(top, ((w - top.width) // 2, 0))
    canvas.alpha_composite(bottom, ((w - bottom.width) // 2, top.height + gap))
    canvas = crop(canvas)
    out = Image.new("RGBA", (1440, 1440), (0, 0, 0, 0))
    scale = min((1440 - 80) / canvas.width, (1440 - 80) / canvas.height)
    canvas = canvas.resize((round(canvas.width * scale), round(canvas.height * scale)), Image.LANCZOS)
    out.alpha_composite(canvas, ((1440 - canvas.width) // 2, (1440 - canvas.height) // 2))
    return out.resize((720, 720), Image.LANCZOS)


def preview(logo, bg, path, size):
    im = Image.new("RGB", size, bg).convert("RGBA")
    im.alpha_composite(logo, ((size[0] - logo.width) // 2, (size[1] - logo.height) // 2))
    im.convert("RGB").save(path, quality=95)


if __name__ == "__main__":
    h = horizontal()
    f = load_font(600)
    m = draw_line("气象推演", f, [10, 15, 11])
    m = m.resize((int(m.width * 0.985), m.height), Image.LANCZOS)
    h_dark_img = crop(render(m, light=True))
    c = Image.new("RGBA", (2560, 800), (0, 0, 0, 0))
    c.alpha_composite(h_dark_img, ((2560 - h_dark_img.width) // 2, (800 - h_dark_img.height) // 2))
    h_dark = c.resize((1280, 400), Image.LANCZOS)

    s = stacked()
    s_dark = Image.new("RGBA", (720, 720), (0, 0, 0, 0))
    # Reuse the alpha shape of the white stacked logo, recolour it dark.
    alpha = s.getchannel("A")
    bbox = alpha.getbbox()
    fill = fill_image(bbox, s.size, True)
    s_dark.paste(fill, (0, 0), alpha)
    e = edge(alpha, 2)
    lay = Image.new("RGBA", s.size, CYAN + (0,))
    lay.putalpha(e.point(lambda v: int(v * 0.50)))
    s_dark = Image.alpha_composite(s_dark, lay)

    h.save(OUT / "logo-horizontal-1280.png")
    h_dark.save(OUT / "logo-horizontal-dark-1280.png")
    s.save(OUT / "logo-stacked-720.png")
    s_dark.save(OUT / "logo-stacked-dark-720.png")

    preview(h, (8, 16, 24), OUT / "logo-horizontal-preview.jpg", (1280, 400))
    preview(h_dark, (246, 250, 251), OUT / "logo-horizontal-preview-light.jpg", (1280, 400))
    preview(s, (8, 16, 24), OUT / "logo-stacked-preview.jpg", (720, 720))
    preview(s_dark, (246, 250, 251), OUT / "logo-stacked-preview-light.jpg", (720, 720))
    print("wrote logo files", OUT)

