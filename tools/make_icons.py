"""สร้างไอคอนแอป (รูปโล่ + เครื่องหมายถูก) — รัน: python tools/make_icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
BLUE = (20, 40, 160, 255)  # #1428a0
WHITE = (255, 255, 255, 255)
SS = 4  # วาดใหญ่แล้วย่อ ให้ขอบเนียน


def draw_icon(size: int, maskable: bool) -> Image.Image:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, s, s], fill=BLUE)
        scale = 0.62  # อยู่ในพื้นที่ปลอดภัย 80%
    else:
        d.rounded_rectangle([0, 0, s, s], radius=int(s * 0.22), fill=BLUE)
        scale = 0.74

    cx, cy = s / 2, s / 2
    w = s * scale * 0.78
    h = s * scale
    top = cy - h / 2
    # โล่
    shield = [
        (cx, top),
        (cx + w / 2, top + h * 0.16),
        (cx + w / 2, top + h * 0.50),
        (cx + w * 0.30, top + h * 0.80),
        (cx, top + h),
        (cx - w * 0.30, top + h * 0.80),
        (cx - w / 2, top + h * 0.50),
        (cx - w / 2, top + h * 0.16),
    ]
    d.polygon(shield, fill=WHITE)
    # เครื่องหมายถูก
    lw = int(s * scale * 0.09)
    check = [
        (cx - w * 0.24, top + h * 0.50),
        (cx - w * 0.05, top + h * 0.68),
        (cx + w * 0.27, top + h * 0.33),
    ]
    d.line(check, fill=BLUE, width=lw, joint="curve")
    for x, y in (check[0], check[-1]):
        d.ellipse([x - lw / 2, y - lw / 2, x + lw / 2, y + lw / 2], fill=BLUE)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    draw_icon(192, False).save(OUT / "icon-192.png")
    draw_icon(512, False).save(OUT / "icon-512.png")
    draw_icon(512, True).save(OUT / "icon-maskable-512.png")
    draw_icon(180, True).convert("RGB").save(OUT / "apple-touch-icon.png")
    print("icons ->", OUT)


if __name__ == "__main__":
    main()
