#!/usr/bin/env python3
"""
Room links for the room signs (Shawn designs the signs himself).

    python3 tools/make_room_signs.py https://ifc2026survey.com/

For each room, two links that open the form with "Is this your session?" for that room:
  NFC tag link   -> write onto the NFC sticker behind the sign's "tap here" spot
  QR link        -> the room's own QR code on the sign (camera users get the same shortcut)

Writes:
  print/room-qr/<room>.png and .svg   room QR codes for the sign design (decode-checked)
  print/room-qr/room-links.csv        both links for every room
  tags/index.html                     phone page to copy each NFC link while writing tags
"""
import csv
import re
import sys
from pathlib import Path
from urllib.parse import quote

import segno

if len(sys.argv) < 2:
    sys.exit("Usage: python3 tools/make_room_signs.py https://ifc2026survey.com/")
BASE = sys.argv[1].rstrip("/") + "/"
ROOT = Path(__file__).parent.parent
OUT = ROOT / "print" / "room-qr"
OUT.mkdir(parents=True, exist_ok=True)

rooms = sorted({r["Room"] for r in csv.DictReader((ROOT / "sessions-ifc2026.csv").open(encoding="utf-8")) if r["Room"]},
               key=lambda r: (r.split()[0], int(re.findall(r"\d+", r)[0]) if re.findall(r"\d+", r) else 0))
import cv2


def reads(img, scale, expected):
    """True if either of OpenCV's two QR readers decodes the code correctly at this size.
    (The classic reader is flaky at some sizes, so a code passes if one reader gets it right.)"""
    im = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale != 1 else img
    readers = [cv2.QRCodeDetector()] + ([cv2.QRCodeDetectorAruco()] if hasattr(cv2, "QRCodeDetectorAruco") else [])
    return any(r.detectAndDecode(im)[0] == expected for r in readers)


rows = []
for room in rooms:
    slug = re.sub(r"[^a-z0-9]+", "-", room.lower()).strip("-")
    nfc, qr_url = BASE + "?nfc&room=" + quote(room), BASE + "?qr&room=" + quote(room)
    qr = segno.make(qr_url, error="m")                       # 4-module quiet zone included below
    qr.save(OUT / f"{slug}.svg", scale=10, border=4)
    qr.save(OUT / f"{slug}.png", scale=30, border=4)
    img = cv2.imread(str(OUT / f"{slug}.png"))
    for scale in (1.0, 0.25):
        if not reads(img, scale, qr_url):
            sys.exit(f"QR CHECK FAILED for {room} at {scale}x. Do not print.")
    rows.append({"Room": room, "NFC tag link": nfc, "QR link": qr_url, "QR file": f"{slug}.png / .svg"})
    print(f"  {room}: QR checked")

# One general QR code (no room) for slides, handouts and the registration desk
general = BASE + "?qr"
segno.make(general, error="m").save(OUT / "general-qr.svg", scale=10, border=4)
segno.make(general, error="m").save(OUT / "general-qr.png", scale=30, border=4)
gimg = cv2.imread(str(OUT / "general-qr.png"))
if not (reads(gimg, 1.0, general) and reads(gimg, 0.25, general)):
    sys.exit("QR CHECK FAILED for the general code. Do not print.")
rows.append({"Room": "(general, any room)", "NFC tag link": BASE + "?nfc", "QR link": general, "QR file": "general-qr.png / .svg"})
print("  General code: QR checked")

with (OUT / "room-links.csv").open("w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)

(ROOT / "tags").mkdir(exist_ok=True)
items = "\n".join(f'<li><strong>{r["Room"]}</strong><code>{r["NFC tag link"]}</code><button data-l="{r["NFC tag link"]}">Copy</button></li>' for r in rows)
(ROOT / "tags" / "index.html").write_text(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>NFC tag links</title><link rel="stylesheet" href="../style.css">
<style>ol{{padding-left:20px}} li{{margin:0 0 14px}} code{{display:block;font-size:13px;word-break:break-all;color:var(--muted);margin:4px 0}}
li button{{height:40px;padding:0 16px;border:2px solid #000;background:#fff;font-weight:700}} li button.done{{background:var(--accent)}}</style></head>
<body><div class="wrap"><header class="top"><p class="kicker">IFC 2026</p><h1>NFC tag links</h1></header>
<p>For each room: tap <strong>Copy</strong>, open your NFC app (NXP TagWriter or NFC Tools), choose <em>write a URL / link</em>, paste, hold the phone to the sticker. Then <strong>lock</strong> the tag (make it read-only) so nobody can change it. Test it: tapping should open the form asking about that room's session.</p>
<ol>{items}</ol></div>
<script>document.querySelectorAll('li button').forEach(function(b){{b.onclick=function(){{navigator.clipboard.writeText(b.dataset.l).then(function(){{b.textContent='Copied';b.classList.add('done');}});}};}});</script>
</body></html>""", encoding="utf-8")
print(f"{len(rows)} rooms: QR codes in {OUT.relative_to(ROOT)}/, links in room-links.csv, tag-writing page at tags/index.html")
