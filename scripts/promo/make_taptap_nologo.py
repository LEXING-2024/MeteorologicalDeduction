"""TapTap 'no logo' promo pair + standalone game logo.

No-logo images: 1920x1080 and 1080x1620, no text and no logo.
Logo: transparent PNG lockups (horizontal 1280px wide, stacked 720px high).
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "promo"))
import make_promos as mp  # noqa: E402
import make_taptap_rich as rich  # noqa: E402

OUT = ROOT / "deliverables" / "taptap"
OUT.mkdir(parents=True, exist_ok=True)
LOGO_DIR = ROOT / "deliverables" / "logo"
LOGO_DIR.mkdir(parents=True, exist_ok=True)
ICON = ROOT / "deliverables" / "icon" / "icon-512.png"


def make_nologo() -> None:
    # Windows editorial slot: keep the main low centre away from the top-right
    # logo overlay and the bottom-left activity UI.
    W, H = 1920, 1080
    ss = 2
    img = rich.weather_scene(
        W * ss, H * ss,
        low=(0.50 * W * ss, 0.54 * H * ss),
        high=(0.78 * W * ss, 0.74 * H * ss),
        title_safe="none",
        letters=False,
    ).resize((W, H), Image.Resampling.LANCZOS)
    img.convert("RGB").save(OUT / "no-logo-landscape-1920x1080.jpg", quality=95, subsampling=1)
    img.convert("RGB").save(OUT / "no-logo-landscape-1920x1080.png", optimize=True)

    W, H = 1080, 1620
    ss = 2
    img = rich.weather_scene(
        W * ss, H * ss,
        low=(0.50 * W * ss, 0.54 * H * ss),
        high=(0.78 * W * ss, 0.74 * H * ss),
        title_safe="none",
        letters=False,
    ).resize((W, H), Image.Resampling.LANCZOS)
    img.convert("RGB").save(OUT / "no-logo-portrait-1080x1620.jpg", quality=95, subsampling=1)
    img.convert("RGB").save(OUT / "no-logo-portrait-1080x1620.png", optimize=True)


def _title_layer(size: int, tracking: int) -> Image.Image:
    """A tight transparent strip containing 气象推演."""
    f = mp.font(mp.FONT_B, size)
    probe = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
    widths = [probe.textlength(ch, font=f) for ch in "气象推演"]
    total = sum(widths) + tracking * 3
    height = size * 1.32
    layer = Image.new("RGBA", (round(total) + 8, round(height)), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x = 4
    for ch, cw in zip("气象推演", widths):
        d.text((x, 2), ch, font=f, fill=(245, 251, 253, 255))
        x += cw + tracking
    return layer


def make_logo() -> None:
    # Horizontal lockup: icon left, wordmark right, transparent.
    W, H = 1280, 400
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    icon_s = 282
    icon = Image.open(ICON).convert("RGB").resize((icon_s, icon_s), Image.Resampling.LANCZOS)
    canvas.paste(icon, (36, (H - icon_s) // 2))
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle([35, (H - icon_s) // 2 - 1, 36 + icon_s, (H - icon_s) // 2 + icon_s],
                        radius=22, outline=(139, 212, 223, 120), width=2)

    word = _title_layer(196, 4)
    wx, wy = 372, (H - word.height) // 2 + 4
    canvas.alpha_composite(word, (wx, wy))
    d = ImageDraw.Draw(canvas)
    d.line([(372, 330), (1210, 330)], fill=(139, 212, 223, 95), width=2)
    canvas.save(LOGO_DIR / "logo-horizontal-1280.png", optimize=True)

    # Stacked lockup: icon above wordmark, transparent, 720x720.
    S = 720
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon_s = 250
    icon = Image.open(ICON).convert("RGB").resize((icon_s, icon_s), Image.Resampling.LANCZOS)
    canvas.paste(icon, ((S - icon_s) // 2, 80))
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle([(S - icon_s) // 2 - 1, 79, (S + icon_s) // 2 + 1, 80 + icon_s],
                        radius=20, outline=(139, 212, 223, 120), width=2)

    word = _title_layer(132, 4)
    canvas.alpha_composite(word, ((S - word.width) // 2, 392))
    d = ImageDraw.Draw(canvas)
    d.line([(S // 2 - 120, 610), (S // 2 + 120, 610)], fill=(139, 212, 223, 80), width=2)
    canvas.save(LOGO_DIR / "logo-stacked-720.png", optimize=True)

    # A dark preview for quick inspection (not for upload).
    for name, src in (("logo-horizontal-preview", LOGO_DIR / "logo-horizontal-1280.png"),
                      ("logo-stacked-preview", LOGO_DIR / "logo-stacked-720.png")):
        logo = Image.open(src).convert("RGBA")
        bg = Image.new("RGB", logo.size, (7, 17, 24))
        bg.paste(logo, (0, 0), logo)
        bg.save(LOGO_DIR / f"{name}.jpg", quality=94, subsampling=1)


if __name__ == "__main__":
    make_nologo()
    # The name-only wordmark is built by make_logo_nameonly.py.
    # Do not regenerate the retired H-icon lockup here.
    print("wrote no-logo pair to", OUT)
