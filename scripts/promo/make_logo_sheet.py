"""Presentation sheet for the name-only wordmark."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
LOGO = ROOT / "deliverables" / "logo"
SANS = "C:/Windows/Fonts/NotoSansSC-VF.ttf"
DIN = "C:/Windows/Fonts/DINNextLTPro-Regular.ttf"
W, H = 1920, 1080
NAVY = (6, 16, 24)
CYAN = (150, 220, 232)
WHITE = (245, 251, 253)
DIM = (150, 178, 188)


def font(path, size, weight=None):
    f = ImageFont.truetype(path, size)
    if weight:
        f.set_variation_by_name(weight)
    return f


def fit(path, width):
    im = Image.open(path).convert("RGBA")
    im = im.crop(im.getbbox())
    h = round(width * im.height / im.width)
    return im.resize((width, h), Image.LANCZOS)


def panel(canvas, box, bg, logo, label, sub, light=False):
    x0, y0, x1, y1 = box
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle(box, radius=8, fill=bg, outline=(34, 62, 72), width=1)
    lx = x0 + (x1 - x0 - logo.width) // 2
    ly = y0 + (y1 - y0 - logo.height) // 2 - 10
    canvas.alpha_composite(logo, (lx, ly))
    f1 = font(SANS, 18, "Medium")
    f2 = font(SANS, 14, "Regular")
    d.text((x0 + 24, y1 - 58), label, font=f1, fill=WHITE if not light else (18, 42, 50))
    d.text((x0 + 24, y1 - 32), sub, font=f2, fill=DIM if not light else (78, 108, 116))


def main():
    canvas = Image.new("RGBA", (W, H), NAVY + (255,))
    d = ImageDraw.Draw(canvas)

    f_t = font(SANS, 40, "Bold")
    d.text((64, 48), "气象推演 · 字标", font=f_t, fill=WHITE)
    f_s = font(SANS, 18, "Regular")
    d.text((64, 104), "只保留游戏名 / 无 H 图标 / 无英文副标 / 透明 PNG", font=f_s, fill=DIM)
    f_r = font(DIN, 13)
    d.text((W - 64 - 360, 64), "NAME-ONLY  WORDMARK  /  2026", font=f_r, fill=(*CYAN, 180))

    dark = (213, 249, 252)
    light = (246, 250, 251)

    hw = fit(LOGO / "logo-horizontal-1280.png", 760)
    hd = fit(LOGO / "logo-horizontal-dark-1280.png", 760)
    sw = fit(LOGO / "logo-stacked-720.png", 240)
    sd = fit(LOGO / "logo-stacked-dark-720.png", 240)

    panel(canvas, (64, 168, 924, 528), (9, 24, 33, 255), hw,
          "横版 / 深色背景", "1280 × 720 画布 · RGBA", False)
    panel(canvas, (996, 168, 1856, 528), (*light, 255), hd,
          "横版 / 浅色背景", "深色字标用于浅底", True)
    panel(canvas, (64, 552, 924, 912), (9, 24, 33, 255), sw,
          "方形 / 深色背景", "720 × 720 · RGBA", False)
    panel(canvas, (996, 552, 1856, 912), (*light, 255), sd,
          "方形 / 浅色背景", "深色字标用于浅底", True)

    f_f = font(SANS, 14, "Regular")
    d.text((64, 944), "TapTap 上传用 1280×720 透明 PNG；图标负责小尺寸识别，字标负责商店页、封面、片头与视频标题。", font=f_f, fill=(146, 174, 184))
    f_f2 = font(DIN, 12)
    d.text((64, 1000), "METEOROLOGICAL  DEDUCTION    /    WORDMARK", font=f_f2, fill=(104, 142, 154))

    canvas.convert("RGB").save(LOGO / "00-logo-sheet.jpg", quality=94, subsampling=0)
    print("wrote", LOGO / "00-logo-sheet.jpg")


if __name__ == "__main__":
    main()


