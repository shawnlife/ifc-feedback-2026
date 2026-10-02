#!/usr/bin/env python3
"""
Room signs: one A4 sign per room with a "tap your phone here" target (an NFC
sticker goes on the BACK, behind the circle) and a room-specific QR code. Both
open the form with "Is this your session?" for that room.

    python3 tools/make_room_signs.py https://your-final-address/

Writes print/room-signs/:
  <room>.png            one A4 sign per room (300 dpi)
  all-room-signs.pdf    every sign, one per page, ready to print
  nfc-links.csv         the link to write onto each room's NFC tag
and tags/index.html   a phone-friendly page to copy each tag link while writing tags
"""
import csv
import io
import re
import sys
from pathlib import Path
from urllib.parse import quote

import segno
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

if len(sys.argv) < 2:
    sys.exit("Usage: python3 tools/make_room_signs.py https://your-final-address/")
BASE = sys.argv[1].rstrip("/") + "/"
ROOT = Path(__file__).parent.parent
OUT = ROOT / "print" / "room-signs"
OUT.mkdir(parents=True, exist_ok=True)
INK, ORANGE, ORANGE_TEXT, MUTED = "#000000", "#F18500", "#A85300", "#545454"
W, H = 2480, 3508                       # A4 portrait at 300 dpi


def font(weight, size):
    """Source Sans 3 (the Resource Alliance font) from the site's own woff2 files."""
    ttf = OUT / f".source-sans-3-{weight}.ttf"
    if not ttf.exists():
        f = TTFont(ROOT / "assets" / "fonts" / f"source-sans-3-{weight}.woff2")
        f.flavor = None
        f.save(ttf)
    return ImageFont.truetype(str(ttf), size)


def centre(d, y, text, f, fill):
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=fill)


def contactless(d, cx, cy, size, width):
    """The standard 'contactless / tap' symbol: four arcs."""
    for i in range(4):
        r = size * (0.28 + i * 0.24)
        d.arc((cx - r - size * 0.55, cy - r, cx + r - size * 0.55, cy + r), -55, 55, fill=INK, width=width)


def sign(room):
    nfc = BASE + "?nfc&room=" + quote(room)
    qr_url = BASE + "?qr&room=" + quote(room)
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)

    # orange band with the logos
    d.rectangle((0, 0, W, 360), fill=ORANGE)
    d.rectangle((0, 360, W, 376), fill=INK)
    ifc = Image.open(ROOT / "source" / "ifc-2026-logo-white-original.webp").convert("RGBA")
    ifc = ifc.crop(ifc.getchannel("A").getbbox())
    ifc = ifc.resize((int(ifc.width * 150 / ifc.height), 150), Image.LANCZOS)
    im.paste(ifc, (140, 105), ifc)
    ra = Image.open(ROOT / "assets" / "brand" / "presented-by-resource-alliance-white.webp").convert("RGBA")
    ra = ra.resize((int(ra.width * 170 / ra.height), 170), Image.LANCZOS)
    im.paste(ra, (W - 140 - ra.width, 95), ra)

    centre(d, 470, room.upper(), font(700, 230), INK)
    centre(d, 760, "HOW WAS THIS SESSION?", font(700, 120), INK)
    centre(d, 915, "Feedback in under a minute. Anonymous, no app, no login.", font(400, 64), MUTED)

    # tap target: the NFC sticker goes on the back, behind the centre of this circle
    cx, cy, r = W // 2, 1640, 520
    d.ellipse((cx - r - 30, cy - r + 36, cx + r - 30, cy + r + 36), fill=INK)          # hard shadow
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=ORANGE, outline=INK, width=22)
    contactless(d, cx + 10, cy - 110, 250, 30)
    f = font(700, 92)
    for i, line in enumerate(["TAP YOUR", "PHONE HERE"]):
        w = d.textlength(line, font=f)
        d.text((cx - w / 2, cy + 120 + i * 104), line, font=f, fill=INK)

    centre(d, 2215, "or scan with your camera", font(400, 70), MUTED)
    qr = segno.make(qr_url, error="m")               # less dense = easier to scan from a distance; still tolerates damage
    buf = io.BytesIO()
    qr.save(buf, kind="png", scale=20, border=4, dark=INK)   # 4-module quiet zone, as the QR standard requires
    q = Image.open(buf).convert("RGB").resize((760, 760), Image.NEAREST)
    qx, qy = (W - 760) // 2, 2410
    d.rectangle((qx - 40 - 24, qy - 40 + 30, qx + 760 + 40 - 24, qy + 760 + 40 + 30), fill=INK)
    d.rectangle((qx - 40, qy - 40, qx + 760 + 40, qy + 760 + 40), fill="white", outline=INK, width=10)
    im.paste(q, (qx, qy))
    short = BASE.replace("https://", "").rstrip("/")
    centre(d, 3290, short, font(700, 64), INK)
    return im, nfc, qr_url


rooms = sorted({r["Room"] for r in csv.DictReader((ROOT / "sessions-ifc2026.csv").open(encoding="utf-8")) if r["Room"]},
               key=lambda r: (r.split()[0], int(re.findall(r"\d+", r)[0]) if re.findall(r"\d+", r) else 0))
pages, rows = [], []
for room in rooms:
    im, nfc, qr_url = sign(room)
    slug = re.sub(r"[^a-z0-9]+", "-", room.lower()).strip("-")
    im.save(OUT / f"{slug}.png", dpi=(300, 300))
    pages.append(im)
    rows.append({"Room": room, "NFC tag link": nfc, "QR link": qr_url})
    # Decode check at full size AND at a small "seen from across the room" size
    import cv2
    img = cv2.imread(str(OUT / f"{slug}.png"))
    for scale in (1.0, 0.35):
        val, *_ = cv2.QRCodeDetector().detectAndDecode(cv2.resize(img, None, fx=scale, fy=scale))
        if val != qr_url:
            sys.exit(f"QR CHECK FAILED for {room} at {scale}x: {val!r}. Do not print.")
    print(f"  {room}: QR scans (full size and small)")
pages[0].save(OUT / "all-room-signs.pdf", save_all=True, append_images=pages[1:], resolution=300)
with (OUT / "nfc-links.csv").open("w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)

# Phone page for writing tags: open it on the phone, tap Copy, paste into the NFC app
(ROOT / "tags").mkdir(exist_ok=True)
items = "\n".join(
    f'<li><strong>{r["Room"]}</strong><code>{r["NFC tag link"]}</code><button data-l="{r["NFC tag link"]}">Copy</button></li>' for r in rows)
(ROOT / "tags" / "index.html").write_text(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>NFC tag links</title><link rel="stylesheet" href="../style.css">
<style>ol{{padding-left:20px}} li{{margin:0 0 14px}} code{{display:block;font-size:13px;word-break:break-all;color:var(--muted);margin:4px 0}}
li button{{height:40px;padding:0 16px;border:2px solid #000;background:#fff;font-weight:700}} li button.done{{background:var(--accent)}}</style></head>
<body><div class="wrap"><header class="top"><p class="kicker">IFC 2026</p><h1>NFC tag links</h1></header>
<p>For each room: tap <strong>Copy</strong>, open your NFC app (NXP TagWriter or NFC Tools), choose <em>write a URL / link</em>, paste, hold the phone to the sticker. Then <strong>lock</strong> the tag (make it read-only) so nobody can change it.</p>
<ol>{items}</ol></div>
<script>document.querySelectorAll('li button').forEach(function(b){{b.onclick=function(){{navigator.clipboard.writeText(b.dataset.l).then(function(){{b.textContent='Copied';b.classList.add('done');}});}};}});</script>
</body></html>""", encoding="utf-8")
print(f"{len(rooms)} room signs in {OUT.relative_to(ROOT)}/ (PNG each + all-room-signs.pdf), tag links in nfc-links.csv and tags/index.html")
