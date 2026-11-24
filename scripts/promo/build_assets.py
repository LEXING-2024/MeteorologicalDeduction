"""Build the TapTap-ready screenshot pack from raw 2x captures."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "capture" / "raw"
OUT = ROOT / "deliverables" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)

SANS = "C:/Windows/Fonts/NotoSansSC-VF.ttf"
SANS_BOLD = "C:/Windows/Fonts/Noto Sans SC Bold (TrueType).otf"
SANS_MED = "C:/Windows/Fonts/Noto Sans SC Medium (TrueType).otf"
MONO = "C:/Windows/Fonts/CascadiaMono.ttf"


def load(name: str) -> Image.Image:
    return Image.open(RAW / name).convert("RGB")


def save_1080(img: Image.Image, name: str, *, quality: int = 95) -> None:
    if img.size != (1920, 1080):
        img = img.resize((1920, 1080), Image.Resampling.LANCZOS)
    img.save(OUT / f"{name}.jpg", quality=quality, subsampling=1)
    img.save(OUT / f"{name}.png", optimize=True)


def save_campaign_all() -> None:
    src = load("05-campaign-all.png")
    # full-resolution reference (3840 x 3436)
    src.save(OUT / "02-campaign-all-72-4k.png", optimize=True)
    w = 1920
    h = round(src.height * w / src.width)
    src.resize((w, h), Image.Resampling.LANCZOS).save(
        OUT / "02-campaign-all-72.jpg", quality=95, subsampling=1
    )


def save_home_4k() -> None:
    src = load("01-home.png")
    src.save(OUT / "01-home-4k.png", optimize=True)


def build_contact_sheet() -> None:
    items = [
        ("01-home.png", "首页"),
        ("05-campaign-all.png", "72 关全战役"),
        ("08-cold-front-clean.png", "第 08 关 · 冷锋"),
        ("10-stationary-front-clean.png", "第 10 关 · 准静止锋"),
        ("19-three-cities-clean.png", "第 19 关 · 三城记"),
        ("24-sea-breeze-clean.png", "第 24 关 · 海陆风"),
        ("25-valley-wind-clean.png", "第 25 关 · 山谷风"),
        ("19-three-cities-running.png", "三步推演 · 实机动画"),
    ]
    cols, rows = 2, 4
    tw, th = 760, 428
    pad = 28
    label_h = 42
    sheet = Image.new("RGB", (cols * tw + pad * 3, rows * (th + label_h) + pad * (rows + 1)), "#0a1118")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype(SANS_MED, 22)
    for index, (name, label) in enumerate(items):
        img = load(name)
        # cover-crop to 16:9 thumbnail
        scale = max(tw / img.width, th / img.height)
        resized = img.resize((round(img.width * scale), round(img.height * scale)), Image.Resampling.LANCZOS)
        left = (resized.width - tw) // 2
        top = (resized.height - th) // 2
        thumb = resized.crop((left, top, left + tw, top + th))
        x = pad + (index % cols) * (tw + pad)
        y = pad + (index // cols) * (th + label_h + pad)
        sheet.paste(thumb, (x, y))
        draw.rectangle([x, y, x + tw - 1, y + th - 1], outline="#263a48")
        draw.text((x + 2, y + th + 12), label, font=font, fill="#b9d2dd")
    sheet.save(OUT / "00-contact-sheet.jpg", quality=94, subsampling=1)


def build_manifest() -> None:
    files = [
        ("01-home.jpg", "首页 / 继续关卡（已完成 18 关）"),
        ("01-home-4k.png", "首页 4K 原图"),
        ("02-campaign-all-72.jpg", "关卡总览：72 关全部可见（1920 宽）"),
        ("02-campaign-all-72-4k.png", "关卡总览：72 关全部可见（4K 原图）"),
        ("03-campaign-overview.jpg", "关卡总览：游戏内滚动视图"),
        ("04-campaign-stage2.jpg", "关卡总览：阶段二"),
        ("05-level-08-cold-front-result.jpg", "第 08 关 冷锋 · 目标达成"),
        ("06-level-10-stationary-front-result.jpg", "第 10 关 准静止锋 · 目标达成"),
        ("07-level-19-three-cities-result.jpg", "第 19 关 三城记 · 目标达成"),
        ("08-level-24-sea-breeze-result.jpg", "第 24 关 海陆风 · 目标达成"),
        ("09-level-25-valley-wind-result.jpg", "第 25 关 山谷风 · 目标达成"),
        ("10-level-08-cold-front-clean.jpg", "第 08 关 冷锋 · 无结算条"),
        ("11-level-19-three-cities-clean.jpg", "第 19 关 三城记 · 无结算条"),
        ("12-level-19-running.jpg", "三步推演动画 · 实机"),
        ("13-settings.jpg", "设置"),
        ("00-contact-sheet.jpg", "截图索引"),
    ]
    manifest = {
        "game": "气象推演",
        "resolution": "1920x1080 (4K reference included)",
        "captured_with": "Chrome 1920x1080 CSS viewport @2x DPR, real game runtime",
        "progress_seed": "18 / 25 levels completed for a lived-in save",
        "representative_levels": [8, 10, 19, 24, 25],
        "files": [{"file": f, "caption": c} for f, c in files],
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    mapping = {
        "01-home.png": "01-home",
        "03-campaign-overview.png": "03-campaign-overview",
        "04-campaign-stage2.png": "04-campaign-stage2",
        "08-cold-front-result.png": "05-level-08-cold-front-result",
        "10-stationary-front-result.png": "06-level-10-stationary-front-result",
        "19-three-cities-result.png": "07-level-19-three-cities-result",
        "24-sea-breeze-result.png": "08-level-24-sea-breeze-result",
        "25-valley-wind-result.png": "09-level-25-valley-wind-result",
        "08-cold-front-clean.png": "10-level-08-cold-front-clean",
        "19-three-cities-clean.png": "11-level-19-three-cities-clean",
        "19-three-cities-running.png": "12-level-19-running",
        "02-settings.png": "13-settings",
    }
    for src, dst in mapping.items():
        save_1080(load(src), dst)
    save_campaign_all()
    save_home_4k()
    build_contact_sheet()
    build_manifest()
    print(f"Wrote {len(list(OUT.glob('*')))} files to {OUT}")


if __name__ == "__main__":
    main()
