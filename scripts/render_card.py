#!/usr/bin/env python3
"""Render a Card Outpost "pull" graphic (1280x720 PNG), styled like the hand-made #pulls-of-the-day images.

Usage:
  python3 scripts/render_card.py '<json>' out.png

JSON fields:
  headline   e.g. "CHASE CARD"
  name       e.g. "MEWTWO GX"
  subline    optional second line under the name (e.g. a year)
  grade      e.g. "PSA 10"
  price      e.g. "$8,904"
  caption    small text under the price, e.g. "MARKET VALUE"
  imagePath  local file with the slab photo (light background is cut out automatically)
"""
import colorsys
import json
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
FONT = os.path.join(ASSETS, "Anton-Regular.ttf")
LOGO = os.path.join(ASSETS, "logo-icon.png")

W, H = 1280, 720
COL_X, COL_W = 70, 560          # left text column
CENTER = COL_X + COL_W // 2
WHITE = (255, 255, 255)
PRICE = (214, 240, 62)          # the yellow-green price colour
RULE = (205, 205, 205)
DEFAULT_ACCENTS = ((110, 50, 210), (30, 45, 140))  # purple/blue, used when there's no photo


def font(size):
    return ImageFont.truetype(FONT, size)


def fit(draw, text, max_size, max_width, min_size=28):
    """Largest font size (<= max_size) at which `text` fits in max_width."""
    size = max_size
    while size > min_size and draw.textlength(text, font=font(size)) > max_width:
        size -= 2
    return font(size)


def glow_tone(rgb, value):
    """Same hue as rgb, made rich and set to a fixed brightness so every card's glow is equally strong."""
    h, s, _ = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))
    r, g, b = colorsys.hsv_to_rgb(h, max(s, 0.65), value)
    return (int(r * 255), int(g * 255), int(b * 255))


def accent_colors(photo):
    """The two most vivid colours in the card's artwork (skipping the PSA label at the top of the slab)."""
    w, h = photo.size
    art = photo.crop((int(w * 0.12), int(h * 0.22), int(w * 0.88), int(h * 0.92))).resize((120, 160))
    palette = art.quantize(colors=12, method=Image.Quantize.MEDIANCUT)
    rgb = palette.getpalette()
    scored = []
    for count, idx in palette.getcolors():
        r, g, b = rgb[idx * 3: idx * 3 + 3]
        _, sat, val = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if sat < 0.25 or val < 0.2:  # skip greys, whites and near-blacks
            continue
        scored.append((count * sat * val, colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[0], (r, g, b)))
    if not scored:
        return DEFAULT_ACCENTS
    scored.sort(reverse=True)
    main = scored[0]
    # second colour: the strongest one with a clearly different hue (else a darker shade of the main one)
    other = next((c for c in scored[1:] if min(abs(c[1] - main[1]), 1 - abs(c[1] - main[1])) > 0.08), main)
    return glow_tone(main[2], 0.82), glow_tone(other[2], 0.55)


def background(accents=DEFAULT_ACCENTS):
    main, second = accents
    bg = Image.new("RGB", (W, H), (6, 7, 16))
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    # dark room with a spotlight in the card's colours behind the slab, brightest at its base
    g.ellipse((780, 420, 1160, 820), fill=main)
    g.ellipse((800, 120, 1130, 520), fill=second)
    g.ellipse((60, 560, 600, 920), fill=tuple(c // 6 for c in second))
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    return ImageChops.add(bg, glow)


def cut_out(photo, tolerance=38):
    """Make the light photo background transparent by flood-filling in from the edges."""
    w, h = photo.size
    marker = (255, 0, 255)
    work = photo.copy()
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for s in seeds:
        if work.getpixel(s) != marker and sum(work.getpixel(s)) > 450:  # only light corners
            ImageDraw.floodfill(work, s, marker, thresh=tolerance)
    mask = Image.new("L", (w, h), 255)
    px, mpx = work.load(), mask.load()
    for y in range(h):
        for x in range(w):
            if px[x, y] == marker:
                mpx[x, y] = 0
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    out = photo.convert("RGBA")
    out.putalpha(mask)
    bbox = mask.getbbox()
    return out.crop(bbox) if bbox else out


def place_slab(canvas, slab, halo_color):
    max_h, max_w = 590, 420
    scale = min(max_h / slab.height, max_w / slab.width)
    slab = slab.resize((int(slab.width * scale), int(slab.height * scale)), Image.LANCZOS)
    x = 960 - slab.width // 2
    y = (H - slab.height) // 2
    # soft glow behind the slab
    halo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(halo).rounded_rectangle(
        (x - 14, y - 10, x + slab.width + 14, y + slab.height + 24), radius=26, fill=halo_color + (210,)
    )
    halo = halo.filter(ImageFilter.GaussianBlur(34))
    canvas.alpha_composite(halo)
    canvas.alpha_composite(slab, (x, y))


def logo(canvas, draw, y):
    icon = Image.open(LOGO).convert("RGBA")
    icon_h = 46
    icon = icon.resize((int(icon.width * icon_h / icon.height), icon_h), Image.LANCZOS)
    f = font(40)
    label = "CARDOUTPOST"
    total = icon.width + 12 + draw.textlength(label, font=f)
    x = int(CENTER - total / 2)
    canvas.alpha_composite(icon, (x, y))
    draw.text((x + icon.width + 12, y + icon_h / 2), label, font=f, fill=WHITE, anchor="lm")
    return y + icon_h


def rule(draw, y, width=COL_W - 40):
    draw.line((CENTER - width / 2, y, CENTER + width / 2, y), fill=RULE, width=2)


def text_line(draw, y, text, max_size, color=WHITE, spacing=0):
    f = fit(draw, text, max_size, COL_W - 20)
    if spacing:
        # letter-spaced small caps line
        widths = [draw.textlength(ch, font=f) for ch in text]
        total = sum(widths) + spacing * (len(text) - 1)
        x = CENTER - total / 2
        top = y
        for ch, cw in zip(text, widths):
            draw.text((x, top), ch, font=f, fill=color, anchor="la")
            x += cw + spacing
        bbox = draw.textbbox((0, 0), text, font=f, anchor="la")
        return y + (bbox[3] - bbox[1])
    bbox = draw.textbbox((CENTER, y), text, font=f, anchor="ma")
    draw.text((CENTER, y), text, font=f, fill=color, anchor="ma")
    return bbox[3]


def render(data, out_path):
    photo = Image.open(data["imagePath"]).convert("RGB") if data.get("imagePath") else None
    accents = accent_colors(photo) if photo else DEFAULT_ACCENTS
    canvas = background(accents).convert("RGBA")
    if photo:
        # halo: the main accent, lifted toward white so it reads as light
        halo = tuple(min(255, int(c * 0.75 + 70)) for c in accents[0])
        place_slab(canvas, cut_out(photo), halo)
    draw = ImageDraw.Draw(canvas)

    sub = bool(data.get("subline"))  # an extra line: tighten everything a little so it all fits
    y = logo(canvas, draw, 36 if sub else 48) + (18 if sub else 22)
    y = text_line(draw, y, data.get("headline", "CHASE CARD").upper(), 84 if sub else 88) + 16
    rule(draw, y)
    y += 14
    y = text_line(draw, y, data["name"].upper(), 66 if sub else 72) + 8
    if sub:
        y = text_line(draw, y, str(data["subline"]).upper(), 52) + 8
    rule(draw, y + 4, COL_W - 120)
    y += 16
    if data.get("grade"):
        y = text_line(draw, y, data["grade"].upper(), 50 if sub else 56) + 12
        rule(draw, y, COL_W - 200)
        y += 10
    y = text_line(draw, y, data["price"], 88 if sub else 96, color=PRICE) + 10
    if data.get("caption"):
        text_line(draw, y, data["caption"].upper(), 26, spacing=4)

    # JPEG keeps the file ~4x smaller than PNG, so it uploads to Discord quickly
    canvas.convert("RGB").save(out_path, "JPEG", quality=92, subsampling=0)


if __name__ == "__main__":
    render(json.loads(sys.argv[1]), sys.argv[2])
    print(sys.argv[2])
