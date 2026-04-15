#!/usr/bin/env python3
"""
Generate icon assets for the standalone-openclaw-launcher package.

Produces:

  src-tauri/icons/32x32.png
  src-tauri/icons/128x128.png
  src-tauri/icons/128x128@2x.png      (256x256)
  src-tauri/icons/icon.ico            (multi-size 16/32/48/64/128/256)
  src-tauri/icons/icon.png            (512x512 master)
  src-tauri/resources/tray-running.png   (green status)
  src-tauri/resources/tray-warn.png      (yellow status)
  src-tauri/resources/tray-error.png     (red status)
  src-tauri/resources/tray-grey.png      (idle status)

The artwork is a rounded-square monogram "OC" — intentionally minimal and
SVG-free so we don't need a vector toolchain. Tray icons share the base
monogram but swap the background color to communicate status at a glance.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICONS_DIR = ROOT / "icons"
RESOURCES_DIR = ROOT / "resources"

ICONS_DIR.mkdir(parents=True, exist_ok=True)
RESOURCES_DIR.mkdir(parents=True, exist_ok=True)

# Brand color for the app icon. Tray icons override this.
APP_BG = (34, 197, 94, 255)        # green-500 — matches the "running" tray
FG = (10, 13, 18, 255)              # near-black text on the tile
TRAY_COLORS = {
    "tray-running.png": (34, 197, 94, 255),   # green
    "tray-warn.png":    (234, 179, 8, 255),   # yellow
    "tray-error.png":   (239, 68, 68, 255),   # red
    "tray-grey.png":    (107, 114, 128, 255), # slate
}


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    # Pillow ships a default bitmap font; try a couple of common system
    # fonts first so the letters look reasonable at larger sizes.
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "C:/Windows/Fonts/segoeuib.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def make_tile(size: int, bg: tuple[int, int, int, int], text: str = "OC") -> Image.Image:
    """Render a rounded-square tile with centered text."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = max(4, size // 5)
    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1),
        radius=radius,
        fill=bg,
    )
    # Text: roughly 55% of tile height.
    font = _load_font(int(size * 0.55))
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    # Bounding box offset can start negative; compensate so text is truly centered.
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=FG)
    return img


def save_app_icons() -> None:
    sizes = [16, 32, 48, 64, 128, 256, 512]
    images = {s: make_tile(s, APP_BG) for s in sizes}

    images[32].save(ICONS_DIR / "32x32.png")
    images[128].save(ICONS_DIR / "128x128.png")
    images[256].save(ICONS_DIR / "128x128@2x.png")
    images[512].save(ICONS_DIR / "icon.png")

    ico_sizes = [16, 32, 48, 64, 128, 256]
    ico_master = images[256]
    ico_master.save(
        ICONS_DIR / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
    )


def save_tray_icons() -> None:
    # Tray icons are 32x32 — Windows scales them down for the notification
    # area. We keep them as plain tinted tiles so status color reads clearly.
    for name, color in TRAY_COLORS.items():
        tile = make_tile(32, color, text="OC")
        tile.save(RESOURCES_DIR / name)


if __name__ == "__main__":
    save_app_icons()
    save_tray_icons()
    print("Generated icons:")
    for p in sorted(ICONS_DIR.glob("*")):
        print(f"  {p.relative_to(ROOT)}")
    for p in sorted(RESOURCES_DIR.glob("tray-*.png")):
        print(f"  {p.relative_to(ROOT)}")
