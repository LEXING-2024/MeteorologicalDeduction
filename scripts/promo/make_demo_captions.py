"""Generate the ASS lower-thirds for the 2026 gameplay demo."""
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "capture" / "demo-run" / "captions.ass"

HEAD = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Noto Sans SC,36,&H00FDFBF5,&H00000000,&H00120A05,&H96000000,-1,0,0,0,100,100,0,0,1,2.0,1.8,7,300,80,820,1
Style: Eye,DIN Next LT Pro,16,&H00E8DC96,&H00000000,&H00120A05,&H96000000,-1,0,0,0,100,100,3.6,0,1,1.2,1.0,7,300,80,812,1
Style: Fx,Noto Sans SC,10,&H00FFFFFF,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

CAPTIONS = [
    # start, end, eyebrow, main, sub, main colour
    (14.8, 19.7, "LEVEL 19  /  THREE CITIES", "三城记", "一张图，同时安排冷锋、高压与偏南风", "&H00FDFBF5&"),
    (74.8, 78.9, "SIMULATION  /  3 STEPS", "风场 → 垂直运动 → 降水", "W ≤ 0 时，降水为 0", "&H00FDFBF5&"),
    (79.4, 84.2, "RESULT  /  24 HOURS", "目标达成", "A 城 24 小时等效降水 89 mm", "&H00B9E178&"),
]


def ts(sec: float) -> str:
    h = int(sec // 3600)
    m = int(sec % 3600 // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


lines = [HEAD]
for start, end, eye, main, sub, colour in CAPTIONS:
    lines.append(
        f"Dialogue: 0,{ts(start)},{ts(end)},Fx,,0,0,0,,{{\\fad(320,420)\\pos(278,790)\\p1\\c&H00120A05&\\alpha&H70&\\blur6}}m 0 0 l 512 0 512 142 0 142{{\\p0}}\n"
    )
    lines.append(
        f"Dialogue: 1,{ts(start)},{ts(end)},Fx,,0,0,0,,{{\\fad(320,420)\\pos(280,790)\\p1\\c&H00E8DC96&\\alpha&H28&}}m 0 0 l 2 0 2 142 0 142{{\\p0}}\n"
    )
    lines.append(
        f"Dialogue: 2,{ts(start)},{ts(end)},Eye,,0,0,0,,{{\\fad(320,420)\\pos(302,812)}}{eye}\n"
    )
    lines.append(
        f"Dialogue: 2,{ts(start)},{ts(end)},Cap,,0,0,0,,{{\\fad(320,420)\\pos(300,842)\\fs36\\c{colour}}}{main}\n"
    )
    lines.append(
        f"Dialogue: 2,{ts(start)},{ts(end)},Cap,,0,0,0,,{{\\fad(320,420)\\pos(300,892)\\fs22\\b0\\c&H00D8E8ED&}}{sub}\n"
    )

OUT.write_text("".join(lines), encoding="utf-8")
print("wrote", OUT)
