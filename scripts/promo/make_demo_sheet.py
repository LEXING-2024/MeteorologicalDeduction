from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
CAP = ROOT / "capture"
OUT = ROOT / "deliverables"
FONT = ImageFont.truetype("C:/Windows/Fonts/Noto Sans SC Medium (TrueType).otf", 20)
TITLE = ImageFont.truetype("C:/Windows/Fonts/Noto Sans SC Bold (TrueType).otf", 24)

items = [
    (1, "首页 / 读取存档", "18 / 25 已完成"),
    (10, "放置冷气团", "真实鼠标操作与放置预览"),
    (25, "调整气压场", "H / L 与悬停数据"),
    (40, "第 19 关 三城记", "三步推演 · 目标达成"),
    (55, "第 24 关 海陆风", "海陆热力差异"),
    (65, "海陆风目标达成", "东北风 19.3 m/s"),
]
tw, th = 620, 349
pad = 24
label_h = 58
cols, rows = 2, 3
sheet = Image.new("RGB", (cols * tw + pad * 3, rows * (th + label_h) + pad * (rows + 1)), "#081018")
draw = ImageDraw.Draw(sheet)

for i, (t, title, sub) in enumerate(items):
    # extract frame with ffmpeg already done by caller? use ffmpeg here
    import subprocess

    frame_path = CAP / f"sheet-{t}.jpg"
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", str(t),
         "-i", str(OUT / "气象推演-实机演示-1080p.mp4"), "-frames:v", "1", str(frame_path)],
        check=True,
    )
    img = Image.open(frame_path).convert("RGB").resize((tw, th), Image.Resampling.LANCZOS)
    x = pad + (i % cols) * (tw + pad)
    y = pad + (i // cols) * (th + label_h + pad)
    sheet.paste(img, (x, y))
    draw.rectangle([x, y, x + tw - 1, y + th - 1], outline="#263a48")
    draw.text((x + 2, y + th + 8), title, font=TITLE, fill="#dcecf1")
    draw.text((x + 2, y + th + 36), sub, font=FONT, fill="#7894a2")

sheet.save(OUT / "demo-contact-sheet.jpg", quality=93, subsampling=1)
print("wrote demo contact sheet")
