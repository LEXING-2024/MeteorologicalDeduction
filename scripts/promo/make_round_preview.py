from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[2] / "deliverables" / "icon"
src = Image.open(root / "icon-1024.png").convert("RGB").resize((512, 512), Image.Resampling.LANCZOS)
mask = Image.new("L", (512, 512), 0)
ImageDraw.Draw(mask).ellipse([8, 8, 504, 504], fill=255)
round_icon = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
round_icon.paste(src, (0, 0), mask)
round_icon.save(root / "preview-round-512.png")
print("round preview")
