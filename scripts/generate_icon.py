"""Generate professional app icons for Server Dashboard."""
from PIL import Image, ImageDraw, ImageFont
import os, math

SIZES = {
    "src-tauri/icons/32x32.png": 32,
    "src-tauri/icons/128x128.png": 128,
    "src-tauri/icons/128x128@2x.png": 256,
}

def create_icon_from_source(source_path: str, size: int) -> Image.Image:
    """Resize source icon to target size, preserving alpha."""
    src = Image.open(source_path)
    if src.mode != "RGBA":
        src = src.convert("RGBA")
    return src.resize((size, size), Image.Resampling.LANCZOS)

if __name__ == "__main__":
    import sys
    base_dir = os.path.join(os.path.dirname(__file__), "..")
    
    # Use icon.png from project root, or generate if missing
    source_path = os.path.join(base_dir, "icon.png")
    if not os.path.exists(source_path):
        print(f"ERROR: {source_path} not found!")
        sys.exit(1)
    
    print(f"Using source icon: {source_path}")
    
    for rel_path, size in SIZES.items():
        full_path = os.path.join(base_dir, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        img = create_icon_from_source(source_path, size)
        img.save(full_path, "PNG")
        print(f"OK Saved {full_path} ({size}x{size})")
    
    # Generate .ico (Windows) with multiple sizes
    ico_path = os.path.join(base_dir, "src-tauri/icons/icon.ico")
    img_256 = create_icon_from_source(source_path, 256)
    img_256.save(ico_path, "ICO", sizes=[(256, 256), (128, 128), (64, 64), (32, 32), (16, 16)])
    print(f"OK Saved {ico_path}")
    
    # icns fallback (just the PNG renamed)
    icns_path = os.path.join(base_dir, "src-tauri/icons/icon.icns")
    import shutil
    shutil.copy(
        os.path.join(base_dir, "src-tauri/icons/128x128.png"),
        icns_path
    )
    print(f"OK Saved {icns_path} (PNG fallback)")
    
    print("\nAll icons generated successfully!")
