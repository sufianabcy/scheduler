"""Draws the app icons into public/icons/: an original, flat red mask with two white lens eyes and a faint web,
on the app's night background. Run: npm run icons (needs Pillow).

The PNGs are committed, so this only needs to run again if the icon design changes. If it does, bump SHELL in
public/sw.js so installed apps pick up the new /icons/icon-192.png (it is pre-cached under a fixed name).
"""

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
NIGHT = (8, 10, 18)  # --bg
RED = (216, 38, 44)  # --red
WEB = (140, 20, 26)  # darker red for the web on the mask
EYE = (234, 246, 255)  # --eye
SCALE = 4  # draw big, then shrink, for smooth edges


def bezier(p0, p1, p2, p3, steps=24):
    """Points along a cubic Bézier curve."""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3
        pts.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return pts


def eye_shape(mirror):
    """A pointed lens shape in mask units (mask centre 0,0; radius about 1). mirror=-1 is the left eye."""
    inner, outer = (0.10, 0.10), (0.66, -0.30)
    top = bezier(inner, (0.16, -0.32), (0.44, -0.44), outer)
    bottom = bezier(outer, (0.70, 0.02), (0.40, 0.22), inner)
    return [(mirror * x, y) for x, y in top + bottom[1:]]


def mask_layer(big, rx, ry, cx, cy, web):
    """The red mask (an egg shape, wider at the top) with optional web lines, as an RGBA layer."""
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    shape = Image.new("L", (big, big), 0)
    ImageDraw.Draw(shape).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=255)
    layer.paste(RED, (0, 0, big, big), shape)

    if web:
        lines = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        draw = ImageDraw.Draw(lines)
        width = max(2, round(big * 0.008))
        hub = (cx, cy + ry * 0.12)
        for i in range(12):
            a = i * math.pi / 6
            draw.line([hub, (hub[0] + math.cos(a) * rx * 2, hub[1] + math.sin(a) * ry * 2)], fill=WEB, width=width)
        for k in (0.35, 0.62, 0.9):
            draw.ellipse([hub[0] - rx * k, hub[1] - ry * k, hub[0] + rx * k, hub[1] + ry * k], outline=WEB, width=width)
        # Keep the web inside the mask.
        lines.putalpha(ImageChops.multiply(lines.getchannel("A"), shape))
        layer.alpha_composite(lines)

    draw = ImageDraw.Draw(layer)
    for mirror in (-1, 1):
        pts = [(cx + x * rx, cy + y * ry) for x, y in eye_shape(mirror)]
        draw.polygon(pts, fill=EYE, outline=NIGHT, width=max(2, round(big * 0.022)))
    return layer


def icon(size, mask_scale, rounded, web=True):
    big = size * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    bg = Image.new("L", (big, big), 0)
    ImageDraw.Draw(bg).rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.22 if rounded else 0, fill=255)
    img.paste(NIGHT, (0, 0, big, big), bg)
    rx, ry = big * 0.36 * mask_scale, big * 0.42 * mask_scale
    img.alpha_composite(mask_layer(big, rx, ry, big / 2, big * 0.52, web))
    return img.resize((size, size), Image.LANCZOS)


def badge(size):
    """Android status-bar badge: only its alpha is used, so a white head with the eyes cut out."""
    big = size * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    rx, ry, cx, cy = big * 0.40, big * 0.47, big / 2, big * 0.5
    draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(255, 255, 255, 255))
    for mirror in (-1, 1):
        draw.polygon([(cx + x * rx, cy + y * ry) for x, y in eye_shape(mirror)], fill=(0, 0, 0, 0))
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    icon(192, 1.0, True).save(OUT / "icon-192.png")
    icon(512, 1.0, True).save(OUT / "icon-512.png")
    # Maskable: full-bleed square; the mask stays inside the central 80% safe zone so Android's shapes don't cut it.
    icon(512, 0.8, False).save(OUT / "maskable-512.png")
    icon(180, 0.9, False).convert("RGB").save(OUT / "apple-touch-icon.png")
    icon(32, 1.1, True, web=False).save(OUT / "favicon-32.png")
    badge(96).save(OUT / "badge-96.png")
    print(f"Icons written to {OUT}")


if __name__ == "__main__":
    main()
