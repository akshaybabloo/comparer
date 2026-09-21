# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["pillow==10.2.0"]
# # Pillow 10.2.0 ships no wheel for 3.13 or later, and building it from source
# # here fails, so the interpreter is held back with it.
# ///
"""Draws the application icon and writes icon.png, icon.ico and icon.icns.

A squircle split down the middle by a jagged white seam: a deep indigo left half
and a brighter violet right half, each carrying faint bars that stand in for lines
of text, offset between the sides so they read as a diff.

Everything is drawn at 4x and downsampled, since Pillow has no anti-aliased
drawing. The output is deterministic, so regenerating and committing is a no-op
unless something here changed — but only against the pinned Pillow. Later
versions resample and blur slightly differently: 12.3.0 moves about 0.6% of the
pixels by up to 10/255, which is invisible and would still rewrite all three
files, and these are tracked in Git LFS.

`src/lib/components/AppMark.svelte` is this same artwork as vector, for the title
bar. It mirrors these constants by hand — the seam's five turns, the corner
radius, the stroke width, the bar rhythm and the seam's shadow — so anything
changed here has to be changed there too, or the app will wear two logos.

    uv run scripts/make-icon.py            # into assets/, beside this checkout
    uv run scripts/make-icon.py some/dir   # somewhere else
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

S = 1024  # master size
SS = 4  # supersample factor
N = S * SS

CORNER_RADIUS = 0.225  # of the canvas, as macOS app icons are
SEAM_WIDTH = 0.062
# The seam, in fractions of the canvas: a four-segment zigzag, overshooting top
# and bottom so its ends are clipped square by the squircle.
SEAM = [(0.545, -0.02), (0.452, 0.29), (0.567, 0.51), (0.438, 0.73), (0.534, 1.02)]
# How far the artwork is darkened under the blurred seam, and how wide that blur
# is as a fraction of the seam itself.
SEAM_SHADOW = 0.7
SEAM_BLUR = 0.5

LEFT_GRADIENT = ((55, 48, 163), (79, 70, 229))  # indigo
RIGHT_GRADIENT = ((124, 58, 237), (167, 139, 250))  # violet
BAR_ALPHA = 36
BAR_HEIGHT = 0.035
LEFT_BARS = (0.26, 0.38, 0.50, 0.62)
RIGHT_BARS = (0.32, 0.44, 0.56, 0.68)

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def gradient(start: tuple[int, int, int], end: tuple[int, int, int]) -> Image.Image:
    """A diagonal gradient, drawn small and scaled up: it is linear anyway."""
    small = Image.new("RGB", (64, 64))
    pixels = small.load()
    for y in range(64):
        for x in range(64):
            t = (x + y) / 126
            pixels[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(start, end))
    return small.resize((N, N), Image.BILINEAR)


def scaled(points):
    return [(x * N, y * N) for x, y in points]


def white() -> Image.Image:
    return Image.new("RGB", (N, N), (255, 255, 255))


def draw() -> Image.Image:
    # Two gradients, divided by the seam's path.
    left_of_seam = Image.new("L", (N, N), 0)
    ImageDraw.Draw(left_of_seam).polygon(
        scaled([(-0.02, -0.02), *SEAM, (-0.02, 1.02)]), fill=255
    )
    icon = Image.composite(
        gradient(*LEFT_GRADIENT), gradient(*RIGHT_GRADIENT), left_of_seam
    )

    # Faint bars, as lines of text, at different heights on each side.
    bars = Image.new("L", (N, N), 0)
    drawing = ImageDraw.Draw(bars)
    for x0, x1, ys in ((0.17, 0.40, LEFT_BARS), (0.60, 0.83, RIGHT_BARS)):
        for y in ys:
            drawing.rounded_rectangle(
                (x0 * N, y * N, x1 * N, (y + BAR_HEIGHT) * N),
                radius=BAR_HEIGHT * N / 2,
                fill=BAR_ALPHA,
            )
    icon = Image.composite(white(), icon, bars)

    # The seam, with round joints and caps, over a soft shadow so the halves read
    # as sitting behind it.
    seam = Image.new("L", (N, N), 0)
    drawing = ImageDraw.Draw(seam)
    width = round(SEAM_WIDTH * N)
    drawing.line(scaled(SEAM), fill=255, width=width, joint="curve")
    for x, y in scaled(SEAM):
        radius = width / 2
        drawing.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
    shadow = seam.filter(ImageFilter.GaussianBlur(width * SEAM_BLUR))
    icon = Image.composite(icon.point(lambda v: round(v * SEAM_SHADOW)), icon, shadow)
    icon = Image.composite(white(), icon, seam)

    # Clip to the squircle and come back down to the master size.
    mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, N - 1, N - 1), radius=round(CORNER_RADIUS * N), fill=255
    )
    icon = icon.convert("RGBA")
    icon.putalpha(mask)
    return icon.resize((S, S), Image.LANCZOS)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / "assets"
    out.mkdir(parents=True, exist_ok=True)

    icon = draw()
    icon.save(out / "icon.png")
    icon.save(out / "icon.ico", sizes=ICO_SIZES)
    icon.save(out / "icon.icns")
    for name in ("icon.png", "icon.ico", "icon.icns"):
        print(f"wrote {out / name} ({(out / name).stat().st_size} bytes)")


if __name__ == "__main__":
    main()
