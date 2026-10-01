#!/usr/bin/env python3
"""
QR code + A5 room sign for the feedback form.

    python3 tools/make_qr.py https://your-final-address/

Needs segno and Pillow. Always scan the result with a real phone before printing.
"""

import sys
from pathlib import Path

import segno
from PIL import Image, ImageDraw, ImageFont

if len(sys.argv) < 2:
    sys.exit("Usage: python3 tools/make_qr.py https://your-final-address/")
URL = sys.argv[1]
# The QR code carries ?qr so the Sheet can tell QR scans from typed/shared links.
# The sign still shows the plain address for typing.
QR_URL = URL + ("&" if "?" in URL else "?") + "qr"
OUT = Path(__file__).parent.parent / "qr"
OUT.mkdir(exist_ok=True)
INK, ORANGE, ORANGE_TEXT, MUTED = "#000000", "#F18500", "#A85300", "#545454"


def font(size, bold=False):
    path = "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf"
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


qr = segno.make(QR_URL, error="h")   # high error correction: survives smudges and glare
qr.save(OUT / "feedback-qr.svg", scale=10, border=2, dark=INK)
qr.save(OUT / "feedback-qr.png", scale=20, border=2, dark=INK)

# A5 portrait at 300dpi
W, H = 1748, 2480
card = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(card)
qr_img = Image.open(OUT / "feedback-qr.png").convert("RGB").resize((1100, 1100), Image.NEAREST)
pad = 50
box = ((W - 1100) // 2 - pad, 620 - pad, (W + 1100) // 2 + pad, 1720 + pad)
d.rectangle((box[0] - 18, box[1] + 22, box[2] - 18, box[3] + 22), fill=INK)   # RA-style hard shadow
d.rectangle(box, fill="white", outline=INK, width=10)
d.rectangle((0, 0, W, 60), fill=ORANGE)
card.paste(qr_img, ((W - 1100) // 2, 620))


def centre(y, text, f, fill):
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=fill)


centre(170, "IFC 2026", font(80, True), ORANGE_TEXT)
centre(290, "RATE THIS SESSION", font(120, True), INK)
centre(450, "Scan, find your session, done. Under a minute.", font(52), MUTED)
short = URL.replace("https://", "").replace("http://", "").rstrip("/")
centre(1880, "No camera? Type:", font(52), MUTED)
centre(1960, short, font(84, True), INK)
centre(2200, "Anonymous. No app, no login.", font(46), MUTED)
card.save(OUT / "feedback-sign-A5.png", dpi=(300, 300))

# Decode check so a broken code never goes to print
try:
    import cv2
    val, *_ = cv2.QRCodeDetector().detectAndDecode(cv2.imread(str(OUT / "feedback-sign-A5.png")))
    print("Decode check:", "OK" if val == QR_URL else f"MISMATCH ({val!r})", "->", val)
except ImportError:
    print("(opencv not installed, skipped decode check: scan it with a phone)")
print("Wrote", *(p.name for p in sorted(OUT.iterdir())))
