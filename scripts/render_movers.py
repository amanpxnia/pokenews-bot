#!/usr/bin/env python3
"""Render the "Top Movers" graphic (1280x720 JPEG): five slabs side by side, ranked, with their price move.

Usage:
  python3 scripts/render_movers.py '<json>' out.jpg

JSON: { "period": "LAST 30 DAYS", "movers": [ { "name", "grade", "year", "change", "from", "to", "imagePath" }, … ] }
  change  e.g. "+427%"   from/to  e.g. "$816" / "$4,302"
"""
import json
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_card import LOGO, PRICE, WHITE, cut_out, font  # same font, logo and slab cut-out as the grail graphic

W, H = 1280, 720
GREEN = (74, 222, 128)
RED = (248, 113, 113)
MUTED = (170, 174, 190)


def background():
    bg = Image.new("RGB", (W, H), (6, 8, 14))
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse((140, 260, 1140, 900), fill=(20, 110, 60))   # green "market up" glow under the slabs
    g.ellipse((-200, -260, 560, 260), fill=(30, 40, 90))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    return ImageChops.add(bg, glow).convert("RGBA")


def fit(draw, text, size, width, min_size=16):
    while size > min_size and draw.textlength(text, font=font(size)) > width:
        size -= 1
    return font(size)


def header(canvas, draw, period):
    icon = Image.open(LOGO).convert("RGBA")
    icon = icon.resize((int(icon.width * 40 / icon.height), 40), Image.LANCZOS)
    canvas.alpha_composite(icon, (48, 38))
    draw.text((48 + icon.width + 10, 58), "CARDOUTPOST", font=font(34), fill=WHITE, anchor="lm")
    draw.text((48, 92), "TOP MOVERS", font=font(78), fill=WHITE, anchor="la")
    draw.text((W - 48, 58), period, font=font(30), fill=PRICE, anchor="rm")
    draw.text((W - 48, 96), "BASED ON CARD OUTPOST SALES", font=font(18), fill=MUTED, anchor="rm")


def pill(draw, cx, y, text, color, up):
    """Rounded pill with a drawn ▲/▼ arrow (the Anton font has no arrow characters)."""
    f = font(30)
    tw = draw.textlength(text, font=f)
    w = tw + 28 + 22
    left = cx - w / 2
    draw.rounded_rectangle((left, y, left + w, y + 44), radius=22, fill=color + (255,))
    ax, ay = left + 22, y + 22
    tri = [(ax - 8, ay + 6), (ax + 8, ay + 6), (ax, ay - 8)] if up else [(ax - 8, ay - 6), (ax + 8, ay - 6), (ax, ay + 8)]
    draw.polygon(tri, fill=(8, 12, 10))
    draw.text((left + 36 + tw / 2, y + 22), text, font=f, fill=(8, 12, 10), anchor="mm")


def render(data, out_path):
    canvas = background()
    draw = ImageDraw.Draw(canvas)
    header(canvas, draw, data.get("period", "LAST 30 DAYS"))

    movers = data["movers"][:5]
    col_w = (W - 60) / len(movers)
    for i, m in enumerate(movers):
        cx = 30 + col_w * i + col_w / 2
        # slab
        slab = cut_out(Image.open(m["imagePath"]).convert("RGB"))
        scale = min(286 / slab.height, (col_w - 40) / slab.width)
        slab = slab.resize((int(slab.width * scale), int(slab.height * scale)), Image.LANCZOS)
        sx, sy = int(cx - slab.width / 2), 214  # below the title, with room for the rank badge
        halo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(halo).rounded_rectangle((sx - 8, sy - 6, sx + slab.width + 8, sy + slab.height + 10), radius=18, fill=(120, 255, 170, 90))
        canvas.alpha_composite(halo.filter(ImageFilter.GaussianBlur(22)))
        canvas.alpha_composite(slab, (sx, sy))
        # rank badge
        draw.ellipse((sx - 16, sy - 18, sx + 30, sy + 28), fill=(214, 240, 62, 255))
        draw.text((sx + 7, sy + 5), str(i + 1), font=font(28), fill=(10, 10, 10), anchor="mm")
        # text under the slab
        ty = sy + slab.height + 18
        up = not str(m["change"]).startswith("-")
        pill(draw, cx, ty, str(m["change"]).lstrip("+-"), GREEN if up else RED, up)
        name = " ".join(filter(None, [m.get("year"), m["name"]])).upper()
        draw.text((cx, ty + 58), name, font=fit(draw, name, 26, col_w - 16), fill=WHITE, anchor="ma")
        draw.text((cx, ty + 92), f'PSA {m["grade"]}', font=font(22), fill=MUTED, anchor="ma")
        draw.text((cx, ty + 120), f'{m["from"]}  →  {m["to"]}', font=fit(draw, f'{m["from"]} → {m["to"]}', 24, col_w - 16), fill=PRICE, anchor="ma")

    canvas.convert("RGB").save(out_path, "JPEG", quality=92, subsampling=0)


if __name__ == "__main__":
    render(json.loads(sys.argv[1]), sys.argv[2])
    print(sys.argv[2])
