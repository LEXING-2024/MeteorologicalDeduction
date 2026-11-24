"""Render the 45.6 s promo from real gameplay captures."""
from __future__ import annotations

import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "capture" / "raw"
OUT = ROOT / "deliverables"
OUT.mkdir(parents=True, exist_ok=True)

W, H = 1920, 1080
FPS = 30
DURATION = 45.6
TOTAL_FRAMES = round(DURATION * FPS)

FONT_BOLD = "C:/Windows/Fonts/Noto Sans SC Bold (TrueType).otf"
FONT_MED = "C:/Windows/Fonts/Noto Sans SC Medium (TrueType).otf"
FONT_REG = "C:/Windows/Fonts/Noto Sans SC (TrueType).otf"
FONT_MONO = "C:/Windows/Fonts/CascadiaMono.ttf"
FONT_DIN = "C:/Windows/Fonts/DINNextLTPro-Bold.ttf"
FONT_DINL = "C:/Windows/Fonts/DINNextLTPro-Light.ttf"

WHITE = (242, 250, 252)
MUTED = (160, 184, 197)
DIM = (116, 140, 153)
CYAN = (139, 212, 223)
GREEN = (142, 224, 196)
AMBER = (230, 178, 110)

SCENES = [
    dict(slug="08-cold-front", no="08", stage="基础系统", name="冷锋",
         desc="冷气团楔入暖空气，雨急，范围窄。", zoom=(1.05, 1.16), focus=((0.43, 0.44), (0.48, 0.47))),
    dict(slug="10-stationary-front", no="10", stage="基础系统", name="准静止锋",
         desc="势均力敌，雨带停在同一座城。", zoom=(1.05, 1.15), focus=((0.46, 0.43), (0.49, 0.46))),
    dict(slug="19-three-cities", no="19", stage="基础组合", name="三城记",
         desc="一张图，三种天气，同时成立。", zoom=(1.03, 1.13), focus=((0.48, 0.47), (0.52, 0.52))),
    dict(slug="24-sea-breeze", no="24", stage="基础组合", name="海陆风",
         desc="海与陆的温差，自己长出风。", zoom=(1.04, 1.14), focus=((0.55, 0.48), (0.60, 0.54))),
    dict(slug="25-valley-wind", no="25", stage="基础组合", name="山谷风",
         desc="山坡受热，谷底的风沿坡向上。", zoom=(1.04, 1.14), focus=((0.50, 0.46), (0.54, 0.50))),
]


def ease_in_out(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def smoothstep(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def load_16x9(name: str, width: int = 2400) -> Image.Image:
    img = Image.open(RAW / name).convert("RGB")
    height = round(img.height * width / img.width)
    return img.resize((width, height), Image.Resampling.LANCZOS)


def tracked_text(draw: ImageDraw.ImageDraw, xy, text, font, fill, tracking=0.0, anchor="left") -> None:
    widths = [draw.textlength(ch, font=font) for ch in text]
    total = sum(widths) + tracking * max(0, len(text) - 1)
    x, y = xy
    if anchor == "center":
        x -= total / 2
    elif anchor == "right":
        x -= total
    for ch, width in zip(text, widths):
        draw.text((x, y), ch, font=font, fill=fill)
        x += width + tracking


def text_shadow(draw, xy, text, font, fill, anchor="left", shadow=(0, 0, 0, 175)) -> None:
    anchor = {"left": "la", "right": "ra", "center": "ma"}.get(anchor, anchor)
    draw.text((xy[0] + 1, xy[1] + 2), text, font=font, fill=shadow, anchor=anchor)
    draw.text(xy, text, font=font, fill=fill, anchor=anchor)


def tracked_shadow(draw, xy, text, font, fill, tracking=0.0, anchor="left") -> None:
    tracked_text(draw, (xy[0] + 1, xy[1] + 2), text, font, (0, 0, 0, 175), tracking, anchor)
    tracked_text(draw, xy, text, font, fill, tracking, anchor)


class Promo:
    def __init__(self) -> None:
        self.font_bold_58 = ImageFont.truetype(FONT_BOLD, 58)
        self.font_bold_50 = ImageFont.truetype(FONT_BOLD, 50)
        self.font_bold_46 = ImageFont.truetype(FONT_BOLD, 46)
        self.font_bold_34 = ImageFont.truetype(FONT_BOLD, 34)
        self.font_bold_100 = ImageFont.truetype(FONT_BOLD, 100)
        self.font_med_23 = ImageFont.truetype(FONT_MED, 23)
        self.font_med_22 = ImageFont.truetype(FONT_MED, 22)
        self.font_med_18 = ImageFont.truetype(FONT_MED, 18)
        self.font_med_16 = ImageFont.truetype(FONT_MED, 16)
        self.font_med_15 = ImageFont.truetype(FONT_MED, 15)
        self.font_med_14 = ImageFont.truetype(FONT_MED, 14)
        self.font_label_15 = ImageFont.truetype(FONT_MED, 15)
        self.font_label_13 = ImageFont.truetype(FONT_MED, 13)
        self.font_reg_16 = ImageFont.truetype(FONT_REG, 16)
        self.font_mono_16 = ImageFont.truetype(FONT_MONO, 16)
        self.font_mono_13 = ImageFont.truetype(FONT_MONO, 13)
        self.font_din_100 = ImageFont.truetype(FONT_DIN, 100)
        self.font_din_44 = ImageFont.truetype(FONT_DIN, 44)
        self.font_din_28 = ImageFont.truetype(FONT_DIN, 28)

        self.home = load_16x9("01-home.png")
        self.campaign = load_16x9("05-campaign-all.png", width=2400)
        self.game = {}
        for scene in SCENES:
            self.game[scene["slug"]] = load_16x9(f"{scene['slug']}-clean.png")

        self.backgrounds = self._make_backgrounds()
        self.gradient = self._make_gradient()
        self.veil = self._make_veil()
        self.shade = Image.alpha_composite(self.gradient, self.veil)
        self.vignette = self._make_vignette()
        self.grain = self._make_grain()

        self.captions = {
            "home": self._caption(
                "连续天气图 · 交互推演",
                "把天气，推演一遍。",
                "放置气压、气团与水汽，让大气自己给出答案。",
            ),
            "campaign": self._caption(
                "全战役 · 6 大阶段",
                "72 关，从一张天气图开始",
                "25 关现已开放 · 后续阶段持续更新",
            ),
            "mechanics": self._caption(
                "核心机制 · THE LOOP",
                "所有天气，都由三步推出来。",
                "按顺序结算：先风，再垂直运动，最后降水。",
            ),
            "end": self._caption(
                "连续天气图 · 交互推演",
                "气象推演",
                "你只负责气压差，剩下的交给大气。",
            ),
        }
        for scene in SCENES:
            self.captions[scene["slug"]] = self._caption(
                f"第 {scene['no']} 关 · {scene['stage']}",
                scene["name"],
                scene["desc"],
            )

        self.success = self._success_layer()
        self.campaign_stats = self._campaign_stats()
        self.mech_cards = self._mechanic_cards()
        self.mech_head = self._mechanics_head()
        self.end_layer = self._end_layer()

    # ---------------------------------------------------------------- layers
    def _make_backgrounds(self) -> dict[str, Image.Image]:
        g3 = Image.open(RAW / "19-three-cities-running.png").convert("RGB").resize((1920, 1080), Image.Resampling.LANCZOS)
        mech = g3.filter(ImageFilter.GaussianBlur(7))
        dark = Image.new("RGBA", (W, H), (4, 9, 14, 150))
        mech = Image.alpha_composite(mech.convert("RGBA"), dark).convert("RGB")

        end = Image.open(RAW / "01-home.png").convert("RGB").resize((1920, 1080), Image.Resampling.LANCZOS)
        end = end.filter(ImageFilter.GaussianBlur(16))
        dark_end = Image.new("RGBA", (W, H), (3, 8, 12, 195))
        end = Image.alpha_composite(end.convert("RGBA"), dark_end).convert("RGB")
        return {"mechanics": mech, "end": end}

    def _make_gradient(self) -> Image.Image:
        yy, xx = np.mgrid[0:H, 0:W]
        bottom = 235 * np.clip((yy - 500) / 580, 0, 1) ** 1.55
        left = 185 * np.clip((820 - xx) / 820, 0, 1) ** 1.25 * np.clip((yy - 330) / 750, 0, 1) ** 0.8
        alpha = np.maximum(bottom, left).astype(np.uint8)
        arr = np.zeros((H, W, 4), dtype=np.uint8)
        arr[..., 3] = alpha
        return Image.fromarray(arr, "RGBA")

    def _make_veil(self) -> Image.Image:
        yy, xx = np.mgrid[0:H, 0:W]
        ax = np.clip((1240 - xx) / 1240, 0, 1) ** 1.25
        ay = np.clip((yy - 540) / 300, 0, 1)
        ay = ay * ay * (3 - 2 * ay)
        alpha = (230 * ax * ay).astype(np.uint8)
        arr = np.zeros((H, W, 4), dtype=np.uint8)
        arr[..., 3] = alpha
        return Image.fromarray(arr, "RGBA")

    def _make_vignette(self) -> np.ndarray:
        yy, xx = np.mgrid[0:H, 0:W]
        r = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
        dark = 0.25 * np.clip((r - 0.42) / 1.05, 0, 1) ** 1.4
        return (1.0 - dark).astype(np.float32)[..., None]

    def _make_grain(self) -> np.ndarray:
        rng = np.random.default_rng(88)
        return rng.normal(0, 2.1, size=(12, H, W, 1)).astype(np.int16)

    def _caption(self, kicker: str, title: str, desc: str) -> Image.Image:
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        draw.rectangle([96, 776, 144, 778], fill=CYAN)
        tracked_shadow(draw, (96, 790), kicker.upper(), self.font_label_15, CYAN, tracking=1.2)
        text_shadow(draw, (96, 818), title, self.font_bold_58, WHITE)
        # keep long copy inside the safe area
        size = 23
        while size > 18 and draw.textlength(desc, font=ImageFont.truetype(FONT_MED, size)) > 1020:
            size -= 1
        font = ImageFont.truetype(FONT_MED, size)
        text_shadow(draw, (97, 902), desc, font, MUTED)
        return layer

    def _success_layer(self) -> Image.Image:
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        cx, cy, r = 106, 748, 8
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=GREEN, width=2)
        draw.line([(cx - 4, cy), (cx - 1, cy + 4), (cx + 5, cy - 4)], fill=GREEN, width=2)
        tracked_text(draw, (126, 738), "目标达成", self.font_med_16, GREEN, tracking=1.2)
        return layer

    def _campaign_stats(self) -> Image.Image:
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        x = 1842
        draw.line([(x - 96, 286), (x, 286)], fill=(139, 212, 223, 70), width=1)
        tracked_text(draw, (x, 300), "已开放", self.font_mono_13, DIM, tracking=2.0, anchor="right")
        tracked_shadow(draw, (x, 325), "25", self.font_din_100, WHITE, tracking=0, anchor="right")
        tracked_text(draw, (x, 440), "关 / 25 关", self.font_mono_16, MUTED, tracking=1.0, anchor="right")
        draw.line([(x - 96, 492), (x, 492)], fill=(139, 212, 223, 45), width=1)
        tracked_text(draw, (x, 510), "全战役", self.font_mono_13, DIM, tracking=2.0, anchor="right")
        tracked_shadow(draw, (x, 532), "72", self.font_din_100, (208, 228, 235), tracking=0, anchor="right")
        tracked_text(draw, (x, 646), "关 / 6 阶段", self.font_mono_16, MUTED, tracking=1.0, anchor="right")
        return layer

    def _mechanics_head(self) -> Image.Image:
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        draw.rectangle([170, 128, 218, 130], fill=CYAN)
        tracked_shadow(draw, (170, 142), "核心机制 · THE LOOP", self.font_label_15, CYAN, tracking=1.8)
        text_shadow(draw, (170, 200), "所有天气，都由三步推出来。", self.font_bold_46, WHITE)
        text_shadow(draw, (171, 266), "风 → 上升 / 下沉 → 降水，每一步都参与结算。", self.font_med_22, MUTED)
        return layer

    def _mechanic_cards(self) -> list[dict]:
        specs = [
            ("01", "风场", "气压差驱动空气，湿区随风平移。", "P 梯度 → 风", CYAN),
            ("02", "上升 / 下沉", "低压抬升，高压抑制，决定 W。", "L 抬升 · H 下沉", GREEN),
            ("03", "降水", "只有上升且越过饱和，才成雨。", "W > 0 且过饱和", AMBER),
        ]
        cards = []
        for index, (no, title, desc, foot, accent) in enumerate(specs):
            layer = Image.new("RGBA", (500, 268), (0, 0, 0, 0))
            draw = ImageDraw.Draw(layer)
            draw.rounded_rectangle([1, 1, 498, 266], radius=4, fill=(8, 17, 24, 218), outline=(46, 69, 82, 230), width=1)
            draw.rectangle([1, 1, 498, 3], fill=accent)
            draw.text((28, 24), no, font=self.font_din_44, fill=accent)
            draw.text((28, 82), title, font=self.font_bold_34, fill=WHITE)
            draw.text((28, 134), desc, font=self.font_med_18, fill=MUTED)
            draw.line([(28, 208), (472, 208)], fill=(139, 212, 223, 35), width=1)
            tracked_text(draw, (28, 224), foot, self.font_label_13, (139, 212, 223, 190), tracking=0.8)
            cards.append({"layer": layer, "xy": (170 + index * 540, 430), "accent": accent})
        return cards

    def _end_layer(self) -> Image.Image:
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        tracked_shadow(draw, (W / 2, 262), "WEATHER SYSTEM", self.font_mono_16, CYAN, tracking=7.0, anchor="center")
        tracked_shadow(draw, (W / 2, 300), "气象推演", self.font_bold_100, WHITE, tracking=12.0, anchor="center")
        draw.line([(W / 2 - 40, 444), (W / 2 + 40, 444)], fill=(139, 212, 223, 160), width=2)
        text_shadow(draw, (W / 2, 478), "你只负责气压差，剩下的交给大气。", self.font_med_22, MUTED, anchor="mm")
        # stats row
        y = 610
        items = [("72", "关战役", 700), ("25", "关现已开放", 960), ("6", "大阶段", 1220)]
        for big, small, x in items:
            draw.text((x, y), big, font=self.font_din_44, fill=WHITE, anchor="mm")
            draw.text((x, y + 46), small, font=self.font_label_13, fill=DIM, anchor="mm")
        for x in (830, 1090):
            draw.line([(x, 580), (x, 660)], fill=(139, 212, 223, 45), width=1)
        draw.line([(W / 2 - 330, 710), (W / 2 + 330, 710)], fill=(139, 212, 223, 38), width=1)
        tracked_text(draw, (W / 2, 738), "浏览器即开即玩 · 现已开放 25 关", self.font_label_13, (139, 212, 223, 180), tracking=1.2, anchor="center")
        text_shadow(draw, (W / 2, 960), "连续天气图 · 交互推演      极光视界工作室", self.font_med_15, (110, 134, 147), anchor="mm")
        return layer

    # ---------------------------------------------------------------- motion
    def kenburns(self, img: Image.Image, p: float, zoom, focus, out=(W, H)) -> Image.Image:
        p = ease_in_out(p)
        z = zoom[0] + (zoom[1] - zoom[0]) * p
        cw = img.width / z
        ch = cw / (W / H)
        cx = (focus[0][0] + (focus[1][0] - focus[0][0]) * p) * img.width
        cy = (focus[0][1] + (focus[1][1] - focus[0][1]) * p) * img.height
        left = min(max(cx - cw / 2, 0), img.width - cw)
        top = min(max(cy - ch / 2, 0), img.height - ch)
        crop = img.crop((left, top, left + cw, top + ch))
        return crop.resize(out, Image.Resampling.BILINEAR)

    def campaign_frame(self, p: float) -> Image.Image:
        p = min(1.0, max(0.0, p))
        # hold briefly at top, then travel the whole 72-level wall
        travel = smoothstep((p - 0.08) / 0.84)
        z = 1.19 + 0.06 * travel
        cw = self.campaign.width / z
        ch = cw / (W / H)
        top = 20 + travel * (self.campaign.height - ch - 40)
        left = (self.campaign.width - cw) / 2
        crop = self.campaign.crop((left, top, left + cw, top + ch))
        return crop.resize((W, H), Image.Resampling.BILINEAR)

    def compose_caption(self, frame: Image.Image, name: str, alpha: float, dy: float = 0.0) -> None:
        if alpha <= 0:
            return
        layer = self.captions[name]
        bbox = layer.getbbox()
        if not bbox:
            return
        part = layer.crop(bbox)
        if alpha < 0.999:
            part.putalpha(part.getchannel("A").point(lambda v: int(v * alpha)))
        frame.alpha_composite(part, (bbox[0], bbox[1] + int(dy)))

    def compose_success(self, frame: Image.Image, alpha: float) -> None:
        if alpha <= 0:
            return
        layer = self.success
        bbox = layer.getbbox()
        part = layer.crop(bbox)
        if alpha < 0.999:
            part.putalpha(part.getchannel("A").point(lambda v: int(v * alpha)))
        frame.alpha_composite(part, (bbox[0], bbox[1] + 6))

    # ---------------------------------------------------------------- scenes
    def scene_home(self, local: float) -> Image.Image:
        p = min(1.0, max(0.0, local / 5.2))
        bg = self.kenburns(self.home, p, (1.005, 1.085), ((0.47, 0.45), (0.49, 0.46)))
        frame = bg.convert("RGBA")
        frame = Image.alpha_composite(frame, self.shade)
        a = smoothstep((local - 0.85) / 1.0)
        self.compose_caption(frame, "home", a, (1 - a) * 22)
        return frame.convert("RGB")

    def scene_campaign(self, local: float) -> Image.Image:
        p = min(1.0, max(0.0, local / 6.2))
        bg = self.campaign_frame(p)
        frame = bg.convert("RGBA")
        frame = Image.alpha_composite(frame, self.shade)
        a = smoothstep((local - 1.0) / 0.65)
        self.compose_caption(frame, "campaign", a, (1 - a) * 20)
        return frame.convert("RGB")

    def scene_game(self, scene: dict, local: float) -> Image.Image:
        p = min(1.0, max(0.0, local / 4.8))
        bg = self.kenburns(self.game[scene["slug"]], p, scene["zoom"], scene["focus"])
        frame = bg.convert("RGBA")
        frame = Image.alpha_composite(frame, self.shade)
        a = smoothstep((local - 0.22) / 0.65)
        self.compose_caption(frame, scene["slug"], a, (1 - a) * 18)
        self.compose_success(frame, smoothstep((local - 1.05) / 0.5))
        return frame.convert("RGB")

    def scene_mechanics(self, local: float) -> Image.Image:
        p = min(1.0, max(0.0, local / 5.2))
        bg = self.kenburns(self.backgrounds["mechanics"], p, (1.0, 1.05), ((0.5, 0.5), (0.52, 0.48)))
        frame = bg.convert("RGBA")
        # a slightly deeper veil keeps the type legible over the chart
        frame = Image.alpha_composite(frame, Image.new("RGBA", (W, H), (4, 10, 15, 62)))
        frame = Image.alpha_composite(frame, self.gradient)

        a = smoothstep((local - 0.2) / 0.7)
        if a > 0:
            bbox = self.mech_head.getbbox()
            part = self.mech_head.crop(bbox)
            if a < 0.999:
                part.putalpha(part.getchannel("A").point(lambda v: int(v * a)))
            frame.alpha_composite(part, (bbox[0], bbox[1] + int((1 - a) * 18)))

        for index, card in enumerate(self.mech_cards):
            ca = smoothstep((local - (0.55 + index * 0.62)) / 0.55)
            if ca <= 0:
                continue
            layer = card["layer"]
            bbox = layer.getbbox()
            part = layer.crop(bbox)
            if ca < 0.999:
                part.putalpha(part.getchannel("A").point(lambda v: int(v * ca)))
            x, y = card["xy"]
            frame.alpha_composite(part, (x + bbox[0], y + bbox[1] + int((1 - ca) * 24)))

        # arrows between the cards
        draw = ImageDraw.Draw(frame)
        for index, x in enumerate((690, 1230)):
            aa = smoothstep((local - (1.05 + index * 0.62)) / 0.5)
            if aa <= 0:
                continue
            col = (139, 212, 223, int(120 * aa))
            draw.line([(x, 540), (x + 30, 540)], fill=col, width=1)
            draw.line([(x + 24, 534), (x + 31, 540), (x + 24, 546)], fill=col, width=1)

        # closing line
        ta = smoothstep((local - 3.0) / 0.7)
        if ta > 0:
            draw = ImageDraw.Draw(frame)
            yy = 772
            draw.line([(170 + (1 - ta) * 30, yy), (1750 - (1 - ta) * 30, yy)], fill=(139, 212, 223, int(70 * ta)), width=1)
            tracked_text(draw, (W / 2, 802), "P 梯度  →  风  →  W  →  R", self.font_med_18, (189, 218, 226, int(225 * ta)), tracking=2.2, anchor="center")
            tracked_text(draw, (W / 2, 846), "你只负责气压差，剩下的交给大气。", self.font_med_18, (139, 212, 223, int(235 * ta)), tracking=1.4, anchor="center")

        return frame.convert("RGB")

    def scene_end(self, local: float) -> Image.Image:
        p = min(1.0, max(0.0, local / 5.0))
        bg = self.kenburns(self.backgrounds["end"], p, (1.03, 1.0), ((0.5, 0.48), (0.5, 0.5)))
        frame = bg.convert("RGBA")
        # radial lift behind the wordmark
        a = smoothstep((local - 0.15) / 0.9)
        if a > 0:
            layer = self.end_layer
            bbox = layer.getbbox()
            part = layer.crop(bbox)
            if a < 0.999:
                part.putalpha(part.getchannel("A").point(lambda v: int(v * a)))
            frame.alpha_composite(part, (bbox[0], bbox[1] + int((1 - a) * 16)))
        return frame.convert("RGB")

    # ---------------------------------------------------------------- master
    def render_at(self, t: float) -> Image.Image:
        """Render one clean segment frame; no transitions, no grain."""
        t = max(0.0, min(t, DURATION))
        if t < 5.2:
            return self.scene_home(t)
        if t < 11.4:
            return self.scene_campaign(t - 5.2)
        if t < 16.2:
            return self.scene_game(SCENES[0], t - 11.4)
        if t < 21.0:
            return self.scene_game(SCENES[1], t - 16.2)
        if t < 25.8:
            return self.scene_game(SCENES[2], t - 21.0)
        if t < 30.6:
            return self.scene_game(SCENES[3], t - 25.8)
        if t < 35.4:
            return self.scene_game(SCENES[4], t - 30.6)
        if t < 40.6:
            return self.scene_mechanics(t - 35.4)
        return self.scene_end(t - 40.6)

    def render(self, t: float) -> Image.Image:
        frame = self.render_at(t)

        # Home -> campaign is a soft dissolve; every UI-to-UI cut dips to black.
        transitions = [
            (5.2, "cross", 0.62),
            (11.4, "dip", 0.46),
            (16.2, "dip", 0.36),
            (21.0, "dip", 0.36),
            (25.8, "dip", 0.36),
            (30.6, "dip", 0.36),
            (35.4, "dip", 0.52),
            (40.6, "dip", 0.66),
        ]
        for boundary, kind, fade in transitions:
            if abs(t - boundary) < fade / 2:
                p = smoothstep((t - (boundary - fade / 2)) / fade)
                a = self.render_at(min(t, boundary - 0.001))
                b = self.render_at(max(t, boundary + 0.001))
                if kind == "cross":
                    frame = Image.blend(a, b, p)
                    dark = math.sin(math.pi * p) * 0.12
                    if dark > 0.002:
                        frame = Image.eval(frame, lambda v: int(v * (1 - dark)))
                else:
                    frame = a if p < 0.5 else b
                    dark = max(0.0, 1.0 - abs(p - 0.5) * 4.0)
                    frame = Image.eval(frame, lambda v: int(v * (1 - dark)))
                break

        arr = np.asarray(frame, dtype=np.int16)
        arr = (arr.astype(np.float32) * self.vignette)
        arr = np.clip(arr, 0, 255).astype(np.int16)
        arr = arr + self.grain[int(t * FPS) % len(self.grain)]
        arr = np.clip(arr, 0, 255).astype(np.uint8)
        return Image.fromarray(arr, "RGB")


def main() -> None:
    preview_only = "--preview" in sys.argv
    promo = Promo()
    if preview_only:
        times = [2.2, 4.4, 5.8, 7.2, 9.8, 10.9, 11.35, 11.45, 13.4, 18.6, 23.8, 28.8, 33.6, 35.2, 35.45, 37.6, 39.4, 40.5, 43.0]
        for t in times:
            frame = promo.render(t)
            frame.save(OUT / f"preview-{t:05.1f}.jpg", quality=93, subsampling=1)
            print("preview", t)
        return

    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
        "-i", str(OUT / "weather-promo-score-v2.wav"),
        "-t", f"{DURATION:.3f}",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-shortest", "-movflags", "+faststart",
        str(OUT / "气象推演-宣传片-1080p.mp4"),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    assert proc.stdin is not None
    for index in range(TOTAL_FRAMES):
        t = index / FPS
        frame = promo.render(t)
        proc.stdin.write(frame.tobytes())
        if index % 60 == 0:
            print(f"frame {index}/{TOTAL_FRAMES}  t={t:.2f}s", flush=True)
    proc.stdin.close()
    code = proc.wait()
    print("ffmpeg exit", code)


if __name__ == "__main__":
    main()
