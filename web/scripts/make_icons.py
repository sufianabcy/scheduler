"""Draws the app icons into public/icons/: the unimpressed round face (black line art on white), redrawn as clean
shapes so it stays sharp at every size. Run: npm run icons (needs Pillow).

The face is described in the coordinates of the original 278 x 278 picture it was traced from, then scaled to each
icon. The PNGs are committed, so this only needs to run again if the icon design changes. If it does, bump SHELL in
public/sw.js so installed apps pick up the new /icons/icon-192.png (it is pre-cached under a fixed name).
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
INK = (17, 17, 17, 255)
PAPER = (255, 255, 255, 255)
SCALE = 4  # draw big, then shrink, for smooth edges
SOURCE = 278  # size of the traced picture


def quad(p0, p1, p2, steps=32):
    """Points along a quadratic Bézier curve."""
    return [
        ((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1])
        for t in (i / steps for i in range(steps + 1))
    ]


def draw_face(draw, size, fit, weight, color):
    """The face, scaled so the traced picture fills `fit` of a size x size canvas, centred. `weight` thickens lines."""
    s = size * fit / SOURCE
    off = size * (1 - fit) / 2
    P = lambda x, y: (off + x * s, off + y * s)  # noqa: E731
    line = max(2, round(7 * s * weight))
    outline = max(2, round(9.5 * s * weight))  # the head and arms are drawn a little heavier, like the original

    def stroke(points, width=line):
        pts = [P(*p) for p in points]
        draw.line(pts, fill=color, width=width, joint="curve")
        r = width / 2
        for x, y in (pts[0], pts[-1]):  # round ends
            draw.ellipse([x - r, y - r, x + r, y + r], fill=color)

    # Head: a slightly wide oval.
    cx, cy, rx, ry = 140, 150, 132, 116
    draw.ellipse([*P(cx - rx, cy - ry), *P(cx + rx, cy + ry)], outline=color, width=outline)

    # Little arms at the bottom, curling back in.
    for m in (1, -1):
        X = lambda x: cx + m * (x - cx)  # noqa: E731
        stroke(quad((X(50), 240), (X(28), 250), (X(26), 268)) + quad((X(26), 268), (X(34), 276), (X(52), 262))[1:], outline)

    # Half-closed eyelids: a flat lid with the eye's curve under it, and three short frown lines between the eyes.
    lid = max(2, 7 * s * weight)
    for x0, x1, y, bx, brx, bry in ((68, 132, 64, 101, 14, 8), (146, 214, 66, 180, 15, 9)):
        draw.rounded_rectangle([*P(x0, y), *P(x1, y + 7 * weight)], radius=lid / 2, fill=color)
        draw.chord([*P(bx - brx, y + 7 * weight - bry), *P(bx + brx, y + 7 * weight + bry)], 0, 180, fill=color)
    for x, top, bottom in ((129.5, 56, 66), (139, 56, 70), (149, 56, 70)):
        stroke([(x, top), (x, bottom)])

    # Eyes: two dots close together.
    for x in (130, 157.5):
        r = 8 * max(1, weight * 0.8)
        draw.ellipse([*P(x - r, 150.5 - r), *P(x + r, 150.5 + r)], fill=color)

    # A small flat mouth.
    stroke([(134, 249.5), (156, 249.5)])


def icon(size, fit, rounded, weight=1.0):
    """White tile (rounded for normal icons, square for maskable / Apple) with the face in black."""
    big = size * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    tile = Image.new("L", (big, big), 0)
    ImageDraw.Draw(tile).rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.22 if rounded else 0, fill=255)
    img.paste(PAPER, (0, 0, big, big), tile)
    draw_face(ImageDraw.Draw(img), big, fit, weight, INK)
    return img.resize((size, size), Image.LANCZOS)


def badge(size):
    """Android status-bar badge: only its alpha is used, so the face's lines in white on transparent, drawn bolder."""
    big = size * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_face(ImageDraw.Draw(img), big, 0.94, 1.8, (255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    icon(192, 0.84, True).save(OUT / "icon-192.png")
    icon(512, 0.84, True).save(OUT / "icon-512.png")
    # Maskable: full-bleed square; the face stays inside the central 80% safe zone so Android's shapes don't cut it.
    icon(512, 0.70, False).save(OUT / "maskable-512.png")
    icon(180, 0.80, False).convert("RGB").save(OUT / "apple-touch-icon.png")
    # Tiny sizes get bolder lines so the face still reads.
    icon(32, 0.92, True, weight=2.2).save(OUT / "favicon-32.png")
    badge(96).save(OUT / "badge-96.png")
    print(f"Icons written to {OUT}")


if __name__ == "__main__":
    main()
