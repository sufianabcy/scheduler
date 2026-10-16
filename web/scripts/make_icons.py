"""Draws the app icons (an original spider-web motif) into public/icons/. Run: npm run icons (needs Pillow).

The PNGs are committed, so this only needs to run again if the icon design changes.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
RED_TOP = (226, 54, 54)
RED_BOTTOM = (150, 18, 30)
WEB = (14, 16, 30)
SCALE = 4  # draw big, then shrink, for smooth edges


def web_lines(size, extent):
    """Spokes and sagging rings of a web, as polylines, centred in a size×size square."""
    cx = cy = size / 2
    radius = size / 2 * extent
    spokes = 8
    angles = [math.pi / 2 + i * 2 * math.pi / spokes for i in range(spokes)]
    lines = [[(cx, cy), (cx + radius * math.cos(a), cy - radius * math.sin(a))] for a in angles]

    for ring in (0.28, 0.52, 0.76, 1.0):
        r = radius * ring
        points = []
        for i in range(spokes):
            a0, a1 = angles[i], angles[(i + 1) % spokes] + (2 * math.pi if i == spokes - 1 else 0)
            p0 = (cx + r * math.cos(a0), cy - r * math.sin(a0))
            p1 = (cx + r * math.cos(a1), cy - r * math.sin(a1))
            mid = (a0 + a1) / 2
            ctrl = (cx + r * 0.78 * math.cos(mid), cy - r * 0.78 * math.sin(mid))
            for step in range(12):
                t = step / 12
                points.append((
                    (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * ctrl[0] + t ** 2 * p1[0],
                    (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * ctrl[1] + t ** 2 * p1[1],
                ))
        points.append(points[0])
        lines.append(points)
    return lines


def icon(size, extent, rounded):
    big = size * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (big, big))
    draw = ImageDraw.Draw(gradient)
    for y in range(big):
        t = y / (big - 1)
        draw.line([(0, y), (big, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(RED_TOP, RED_BOTTOM)))

    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.22 if rounded else 0, fill=255)
    img.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(img)
    width = max(2, round(big * 0.018))
    for line in web_lines(big, extent):
        draw.line(line, fill=WEB, width=width, joint="curve")
    dot = big * 0.045
    draw.ellipse([big / 2 - dot, big / 2 - dot, big / 2 + dot, big / 2 + dot], fill=WEB)
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    icon(192, 0.78, True).save(OUT / "icon-192.png")
    icon(512, 0.78, True).save(OUT / "icon-512.png")
    # Maskable: full-bleed square, web kept inside the 80% safe zone so Android's mask shapes don't cut it.
    icon(512, 0.62, False).save(OUT / "maskable-512.png")
    icon(180, 0.66, False).convert("RGB").save(OUT / "apple-touch-icon.png")
    icon(32, 0.85, True).save(OUT / "favicon-32.png")
    print(f"Icons written to {OUT}")


if __name__ == "__main__":
    main()
