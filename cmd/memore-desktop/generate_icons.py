"""
Memore 图标生成脚本

从 memore.png 生成所有平台需要的图标文件：
- Windows: icon.ico (多尺寸 ICO) + icon.png (256x256)
- Android: mipmap-* (各分辨率 ic_launcher, ic_launcher_round, ic_launcher_foreground)
- Web: android-chrome-192x192.png, android-chrome-512x512.png, apple-touch-icon.png
"""
import struct
import io
import os
import sys

try:
    from PIL import Image
except ImportError:
    print("请先安装 Pillow: pip install Pillow")
    sys.exit(1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
SOURCE_PNG = os.path.join(REPO_ROOT, "memore.png")

if not os.path.exists(SOURCE_PNG):
    print(f"源图标不存在: {SOURCE_PNG}")
    sys.exit(1)

img = Image.open(SOURCE_PNG).convert("RGBA")
print(f"源图标: {SOURCE_PNG} ({img.width}x{img.height})")


def save_resized(target_path: str, size: int):
    resized = img.resize((size, size), Image.LANCZOS)
    resized.save(target_path, format="PNG")
    print(f"  -> {target_path} ({size}x{size})")


def generate_ico(target_path: str, sizes: list[int]):
    png_datas = []
    for s in sizes:
        buf = io.BytesIO()
        img.resize((s, s), Image.LANCZOS).save(buf, format="PNG")
        png_datas.append(buf.getvalue())

    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + len(sizes) * 16
    entries = b""
    for i, s in enumerate(sizes):
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(png_datas[i]), offset)
        offset += len(png_datas[i])

    with open(target_path, "wb") as f:
        f.write(header + entries)
        for pd in png_datas:
            f.write(pd)
    print(f"  -> {target_path} (sizes: {sizes})")


# --- Windows Desktop (Wails / go-winres) ---
print("\n[Windows Desktop]")
desktop_dir = os.path.join(REPO_ROOT, "cmd", "memore-desktop")
generate_ico(os.path.join(desktop_dir, "icon.ico"), [16, 24, 32, 48, 64, 128, 256])
save_resized(os.path.join(desktop_dir, "icon.png"), 256)

# --- Web (public/) ---
print("\n[Web Public]")
web_public = os.path.join(REPO_ROOT, "web", "public")
save_resized(os.path.join(web_public, "android-chrome-192x192.png"), 192)
save_resized(os.path.join(web_public, "android-chrome-512x512.png"), 512)
save_resized(os.path.join(web_public, "apple-touch-icon.png"), 180)

# --- Android (Capacitor) ---
print("\n[Android]")
android_res = os.path.join(REPO_ROOT, "web", "android", "app", "src", "main", "res")

mipmap_sizes = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

foreground_sizes = {
    "mipmap-mdpi": 108,
    "mipmap-hdpi": 162,
    "mipmap-xhdpi": 216,
    "mipmap-xxhdpi": 324,
    "mipmap-xxxhdpi": 432,
}

for folder, size in mipmap_sizes.items():
    target_dir = os.path.join(android_res, folder)
    os.makedirs(target_dir, exist_ok=True)
    save_resized(os.path.join(target_dir, "ic_launcher.png"), size)
    save_resized(os.path.join(target_dir, "ic_launcher_round.png"), size)

for folder, size in foreground_sizes.items():
    target_dir = os.path.join(android_res, folder)
    os.makedirs(target_dir, exist_ok=True)
    fg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    icon_size = int(size * 0.50)
    icon_resized = img.resize((icon_size, icon_size), Image.LANCZOS)
    offset = (size - icon_size) // 2
    fg.paste(icon_resized, (offset, offset), icon_resized)
    fg.save(os.path.join(target_dir, "ic_launcher_foreground.png"), format="PNG")
    print(f"  -> {os.path.join(target_dir, 'ic_launcher_foreground.png')} ({size}x{size}, icon {icon_size}x{icon_size})")

# splash screen
splash_path = os.path.join(android_res, "drawable", "splash.png")
if os.path.exists(os.path.join(android_res, "drawable")):
    save_resized(splash_path, 512)

print("\n图标生成完成！")
