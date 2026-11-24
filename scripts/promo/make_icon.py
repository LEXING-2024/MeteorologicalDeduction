"""Build the game icon: pressure chart, H, and a cold front."""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "deliverables" / "icon"
OUT.mkdir(parents=True, exist_ok=True)
S = 2048

FONT_SERIF = "C:/Windows/Fonts/Source Han Serif SC Heavy (TrueType).ttf"
WHITE = (242, 250, 252)
CYAN = (139, 212, 223)
COLD = (108, 160, 194)
AMBER = (224, 166, 108)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def background() -> Image.Image:
    yy, xx = np.mgrid[0:S, 0:S]
    # deep marine vertical gradient
    t = yy / (S - 1)
    top = np.array([7, 15, 22], dtype=np.float32)
    bottom = np.array([11, 27, 37], dtype=np.float32)
    arr = top + (bottom - top) * t[..., None]
    # soft central glow behind the mark
    r = np.sqrt(((xx - S * 0.5) / (S * 0.52)) ** 2 + ((yy - S * 0.45) / (S * 0.52)) ** 2)
    glow = np.clip(1 - r, 0, 1) ** 2 * 18
    arr = arr + glow[..., None] * np.array([0.45, 0.9, 1.0], dtype=np.float32)
    # fine diagonal chart grid
    grid = ((xx + yy) % 96 < 2).astype(np.float32) * 3.0
    arr = arr + grid[..., None] * np.array([0.5, 0.8, 1.0], dtype=np.float32)
    arr = np.clip(arr, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGB")


def chart_curves(draw: ImageDraw.ImageDraw) -> None:
    cx, cy = S * 0.5, S * 0.52
    for index, (base, width, alpha) in enumerate(((430, 16, 78), (610, 15, 66), (790, 14, 54), (980, 13, 40))):
        theta = np.linspace(0, math.tau, 720)
        r = base + 34 * np.sin(3 * theta + 0.6 + index * 0.3) + 20 * np.sin(5 * theta - 0.4)
        x = cx + r * np.cos(theta) * 1.06
        y = cy + r * np.sin(theta) * 0.84
        points = list(zip(x.tolist(), y.tolist()))
        draw.line(points + [points[0]], fill=(*CYAN, alpha), width=width, joint="curve")
    # isobar ticks at the upper-left, like a chart label
    for offset in (0, 1, 2):
        x = 150 + offset * 54
        draw.line([(x, 270), (x, 390)], fill=(*CYAN, 45), width=3)


def h_mask() -> Image.Image:
    mask = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(mask)
    left, right = 700, 1348
    top, bottom = 560, 1450
    stem = 132
    cross_top, cross_bottom = 920, 1052
    radius = 26
    # two stems
    d.rounded_rectangle([left, top, left + stem, bottom], radius=radius, fill=255)
    d.rounded_rectangle([right - stem, top, right, bottom], radius=radius, fill=255)
    # crossbar
    d.rounded_rectangle([left, cross_top, right, cross_bottom], radius=radius, fill=255)
    return mask


def white_h() -> Image.Image:
    mask = h_mask()
    yy = np.mgrid[0:S, 0:S][0]
    t = yy / (S - 1)
    top = np.array([255, 255, 255], dtype=np.float32)
    bottom = np.array([186, 226, 234], dtype=np.float32)
    grad = top + (bottom - top) * t[..., None]
    grad = np.repeat(grad[:, :, None, :], 1, axis=2)[:, :, 0, :]
    arr = np.zeros((S, S, 3), dtype=np.uint8)
    arr[:] = grad.astype(np.uint8)
    h = Image.fromarray(arr, "RGB").convert("RGBA")
    h.putalpha(mask)
    return h


def cold_front(draw: ImageDraw.ImageDraw) -> None:
    # a gently curved front across the lower third
    points = []
    for i in range(120):
        t = i / 119
        x = 120 + t * 1810
        y = 1640 - 70 * math.sin(math.pi * t) - 120 * t
        points.append((x, y))
    draw.line(points, fill=(*COLD, 225), width=26, joint="curve")
    # triangles pointing down-left
    for t in (0.12, 0.34, 0.56, 0.78):
        i = int(t * 119)
        x, y = points[i]
        draw.polygon([(x - 34, y + 8), (x + 34, y + 8), (x, y + 78)], fill=(*COLD, 235))



def h_icon() -> Image.Image:
    bg = background().convert("RGBA")
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    chart_curves(d)
    bg = Image.alpha_composite(bg, layer)

    h = white_h()
    # cyan halo
    halo = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    halo.paste((*CYAN, 90), (0, 0), h.getchannel("A"))
    halo = halo.filter(ImageFilter.GaussianBlur(34))
    bg = Image.alpha_composite(bg, halo)
    bg = Image.alpha_composite(bg, h)

    front = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    fd = ImageDraw.Draw(front)
    cold_front(fd)
    bg = Image.alpha_composite(bg, front)

    # bottom vignette for depth
    yy = np.mgrid[0:S, 0:S][0]
    alpha = (np.clip((yy - S * 0.62) / (S * 0.38), 0, 1) ** 1.4 * 110).astype(np.uint8)
    shade = np.zeros((S, S, 4), dtype=np.uint8)
    shade[..., 3] = alpha
    bg = Image.alpha_composite(bg, Image.fromarray(shade, "RGBA"))
    return bg.convert("RGB")


def qi_icon() -> Image.Image:
    bg = background().convert("RGBA")
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    chart_curves(d)
    bg = Image.alpha_composite(bg, layer)

    font = ImageFont.truetype(FONT_SERIF, 1120)
    txt = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    td = ImageDraw.Draw(txt)
    td.text((S / 2, S * 0.47), "气", font=font, fill=(242, 250, 252, 255), anchor="mm")
    bbox = txt.getbbox()
    # halo
    halo = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    halo.paste((*CYAN, 80), (0, 0), txt.getchannel("A"))
    halo = halo.filter(ImageFilter.GaussianBlur(30))
    bg = Image.alpha_composite(bg, halo)
    bg = Image.alpha_composite(bg, txt)

    front = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    fd = ImageDraw.Draw(front)
    cold_front(fd)
    bg = Image.alpha_composite(bg, front)
    return bg.convert("RGB")


def save_pack(master: Image.Image, folder: Path) -> None:
    master = master.resize((1024, 1024), Image.Resampling.LANCZOS)
    folder.mkdir(parents=True, exist_ok=True)
    for size in (1024, 512, 256, 192, 180, 128, 64, 48):
        master.resize((size, size), Image.Resampling.LANCZOS).save(folder / f"icon-{size}.png", optimize=True)


def main() -> None:
    a = h_icon()
    b = qi_icon()
    a.save(OUT / "concept-h-master.png", optimize=True)
    b.save(OUT / "concept-qi-master.png", optimize=True)
    a.resize((512, 512), Image.Resampling.LANCZOS).save(OUT / "concept-h-512.png")
    b.resize((512, 512), Image.Resampling.LANCZOS).save(OUT / "concept-qi-512.png")
    a.resize((96, 96), Image.Resampling.LANCZOS).save(OUT / "concept-h-96.png")
    b.resize((96, 96), Image.Resampling.LANCZOS).save(OUT / "concept-qi-96.png")
    save_pack(a, OUT)
    save_pack(b, OUT / "alt-qi")
    print("wrote icon concepts")


if __name__ == "__main__":
    main()
