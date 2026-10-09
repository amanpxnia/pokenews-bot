#!/usr/bin/env python3
"""Read the text on a PSA slab's label (top part of the photo) with Tesseract OCR.

Linux counterpart of read_label.swift (which uses macOS's built-in Vision OCR).
Usage: python3 scripts/read_label.py <image-path>   → prints the label lines, top to bottom.
"""
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageOps

photo = Image.open(sys.argv[1]).convert("L")
w, h = photo.size
# The PSA label's text sits inside the red frame near the top of the slab photo; crop just that
# (the slab edges confuse Tesseract) and enlarge it so the small print reads cleanly
label = photo.crop((int(w * 0.08), int(h * 0.035), int(w * 0.92), int(h * 0.13)))
label = ImageOps.autocontrast(label.resize((label.width * 3, label.height * 3), Image.LANCZOS))

with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, "label.png")
    label.save(path)
    out = subprocess.run(["tesseract", path, "stdout", "--psm", "6"], capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        sys.exit(out.stderr.strip() or "tesseract failed")
    print("\n".join(line.strip() for line in out.stdout.splitlines() if line.strip()))
