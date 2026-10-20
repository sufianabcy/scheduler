"""Draws the faint web behind the app (src/assets/web.svg), in the style of the films' webs rather than a neat
target: spokes at uneven angles, strands that sag in towards the centre between them, gaps that widen outwards,
a few broken and dangling strands, and a tangled knot at the hub. Run: npm run web (plain Python, no packages).

The SVG is used as a CSS mask, so only its shape matters: white lines that fade out towards the edge. The colour comes
from --web-line in theme.css. The random numbers are seeded, so running it again gives the same web; change SEED for
a different one. `--preview <file>` also writes a white-on-dark copy, for looking at it.
"""

import math
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "assets" / "web.svg"
SEED = 7
SIZE = 1000
CX, CY = 500, 500  # the hub
R = 470  # how far the spokes reach


def f(x):
    return f"{x:.1f}".rstrip("0").rstrip(".")


def build(rng):
    paths = []  # (d, stroke width)

    # Spokes: about 15, unevenly spaced, a little longer or shorter each.
    n = 15
    angles = sorted(i * 2 * math.pi / n + rng.uniform(-0.16, 0.16) for i in range(n))
    reach = [R * rng.uniform(0.88, 1.0) for _ in angles]

    # Rings: the gaps grow outwards. Each strand's junction on a spoke sits a little in or out.
    radii, r = [], 26
    while r < R:
        radii.append(r)
        r = r * rng.uniform(1.17, 1.27) + rng.uniform(10, 18)
    junction = [[rad * rng.uniform(0.94, 1.06) for _ in angles] for rad in radii]

    def point(k, i):
        a, d = angles[i % n], junction[k][i % n]
        return CX + d * math.cos(a), CY + d * math.sin(a)

    # Spokes are pulled slightly sideways where strands tug on them, so they're drawn through their junctions.
    for i, a in enumerate(angles):
        pts = [(CX, CY)]
        for k in range(len(radii)):
            if junction[k][i] < reach[i]:
                x, y = point(k, i)
                nudge = rng.uniform(-2.5, 2.5)
                pts.append((x - math.sin(a) * nudge, y + math.cos(a) * nudge))
        end = (CX + reach[i] * math.cos(a), CY + reach[i] * math.sin(a))
        pts.append(end)
        paths.append(("M" + " L".join(f"{f(x)} {f(y)}" for x, y in pts), 2.6))
        # Some anchor lines split in two near the end, as if tied to two points.
        if rng.random() < 0.4:
            fork = reach[i] * rng.uniform(0.72, 0.84)
            fx, fy = CX + fork * math.cos(a), CY + fork * math.sin(a)
            b = a + rng.choice((-1, 1)) * rng.uniform(0.1, 0.17)
            paths.append((f"M{f(fx)} {f(fy)} L{f(CX + (reach[i] + 15) * math.cos(b))} {f(CY + (reach[i] + 15) * math.sin(b))}", 2.0))

    # Strands between neighbouring spokes, sagging towards the hub (the films' scalloped look).
    for k in range(len(radii)):
        width = 2.1 if k < 3 else 1.8
        for i in range(n):
            if junction[k][i] > reach[i] or junction[k][(i + 1) % n] > reach[(i + 1) % n]:
                continue
            (x0, y0), (x1, y1) = point(k, i), point(k, i + 1)
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            chord = math.hypot(x1 - x0, y1 - y0)
            dist = math.hypot(mx - CX, my - CY)
            sag = chord * rng.uniform(0.17, 0.28)
            qx, qy = mx - (mx - CX) / dist * sag, my - (my - CY) / dist * sag
            roll = rng.random()
            if k > 1 and roll < 0.06:
                continue  # missing
            if k > 2 and roll < 0.11:
                # Snapped: one end hangs loose and droops down.
                # Snapped: it hangs from one end and falls under its own weight.
                hx, hy = (x0, y0) if y0 < y1 else (x1, y1)
                drop = chord * rng.uniform(0.6, 0.9)
                ex, ey = hx + (mx - hx) * 0.5, hy + drop
                paths.append((f"M{f(hx)} {f(hy)} Q{f(mx)} {f(hy + drop * 0.25)} {f(ex)} {f(ey)}", width * 0.8))
                continue
            paths.append((f"M{f(x0)} {f(y0)} Q{f(qx)} {f(qy)} {f(x1)} {f(y1)}", width))

    # The hub: a small tangle of loops rather than neat circles.
    for _ in range(7):
        a0 = rng.uniform(0, 2 * math.pi)
        pts = []
        for j in range(9):
            a = a0 + j * 2 * math.pi / 8 + rng.uniform(-0.2, 0.2)
            d = rng.uniform(6, 24)
            pts.append((CX + d * math.cos(a), CY + d * math.sin(a)))
        d = f"M{f(pts[0][0])} {f(pts[0][1])}" + "".join(
            f" Q{f(cx)} {f(cy)} {f((cx + nx) / 2)} {f((cy + ny) / 2)}" for (cx, cy), (nx, ny) in zip(pts[1:], pts[2:])
        )
        paths.append((d, 1.5))

    # A few stray threads drifting off beyond the web.
    for _ in range(3):
        a = rng.uniform(0, 2 * math.pi)
        r0 = R * rng.uniform(0.55, 0.8)
        x0, y0 = CX + r0 * math.cos(a), CY + r0 * math.sin(a)
        x1, y1 = CX + (R + 20) * math.cos(a + 0.12), CY + (R + 20) * math.sin(a + 0.12)
        paths.append((f"M{f(x0)} {f(y0)} Q{f((x0 + x1) / 2 + 12)} {f((y0 + y1) / 2 + 18)} {f(x1)} {f(y1)}", 1.2))
    return paths


def svg(paths, preview=False):
    stroke = "#fff" if preview else "url(#fade)"
    bg = '<rect width="100%" height="100%" fill="#080a12"/>' if preview else ""
    body = "".join(f'<path d="{d}" stroke-width="{w}"/>' for d, w in paths)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}">{bg}'
        f'<defs><radialGradient id="fade" gradientUnits="userSpaceOnUse" cx="{CX}" cy="{CY}" r="{R + 30}">'
        '<stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#fff"/>'
        '<stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>'
        f'<g fill="none" stroke="{stroke}" stroke-linecap="round" stroke-linejoin="round">{body}</g></svg>\n'
    )


def main():
    paths = build(random.Random(SEED))
    OUT.write_text(svg(paths))
    print(f"Web written to {OUT} ({OUT.stat().st_size} bytes)")
    if "--preview" in sys.argv:
        Path(sys.argv[sys.argv.index("--preview") + 1]).write_text(svg(paths, preview=True))


if __name__ == "__main__":
    main()
