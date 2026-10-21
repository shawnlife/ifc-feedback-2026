#!/usr/bin/env python3
"""
Turn Shawn's Session Leader allocation sheet (private/IFC26 - Session Leader Allocations.xlsx,
"Room Allocation" tab) into private/session-leader-allocations.csv: one row per session with its
Session Leaders. Import that CSV into the Google Sheet as a tab called "Session Leader allocations"
(File > Import > Upload > Insert new sheet(s), or Replace current sheet when updating it).
The dashboard uses it to show who still owes a Session Leader report.

Masterclasses: the Tuesday column is part 1 (ID + "-P1"), Wednesday 9:00 is part 2.
Sessions that aren't in sessions-ifc2026.csv (cancelled) are listed at the end and left out.
"""
import csv, re
from pathlib import Path
import openpyxl

ROOT = Path(__file__).parent.parent
SRC = ROOT / "private" / "IFC26 - Session Leader Allocations.xlsx"
OUT = ROOT / "private" / "session-leader-allocations.csv"
DAYS = {"tue": "2026-10-20", "wed": "2026-10-21", "thu": "2026-10-22", "fri": "2026-10-23"}

sessions = list(csv.DictReader((ROOT / "sessions-ifc2026.csv").open(encoding="utf-8")))
by_slot = {(s["Date"], s["Start"], s["Room"]): s for s in sessions}


def norm(t):
    t = str(t or "").lower().replace("’", "'").replace("…", "...")
    t = re.sub(r"^(masterclass|innovation hub|open discussion|big topics?)\s*:\s*", "", t)
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


rows = list(openpyxl.load_workbook(SRC, read_only=True, data_only=True)["Room Allocation"].iter_rows(values_only=True))
days, times = rows[0], rows[1]
out, skipped = [], []
day = None
for c in range(1, len(times)):
    if days[c]:
        day = DAYS.get(str(days[c]).strip()[:3].lower())
    t = str(times[c] or "")
    m = re.match(r"(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})", t)
    if not m or not day or str(times[c + 1] if c + 1 < len(times) else "").strip() != "Session Leader":
        continue
    start = f"{int(m[1]):02d}:{m[2]}"
    for r in rows[2:]:
        room, title, who = r[0], r[c], r[c + 1] if c + 1 < len(r) else None
        if not room or not title or str(room).strip().upper().startswith("SESSION COUNT"):
            continue
        names = [n.strip().rstrip("*").strip() for n in re.split(r"[/\n,&]+", str(who or "")) if n.strip()]
        names = [n for n in names if n and n != "?"]
        room = str(room).strip()
        part1 = day == "2026-10-20"
        s = by_slot.get(("2026-10-21", "09:00", room)) if part1 else by_slot.get((day, start, room))
        if s is None or norm(s["Title"]) != norm(title):
            # same slot, other room spelling: match on the title instead
            cands = [x for x in sessions if norm(x["Title"]) == norm(title) and ((part1 and x["Track"] == "Masterclasses") or (not part1 and (x["Date"], x["Start"]) == (day, start)))]
            s = cands[0] if cands else None
        if s is None:
            skipped.append(f"{day} {start} {room}: {title} ({' / '.join(names) or 'no leader'})")
            continue
        out.append({
            "Session ID": s["ID"] + ("-P1" if part1 else ""),
            "Session": str(title).strip() + (" (Part 1)" if part1 else (" (Part 2)" if s["Track"] == "Masterclasses" else "")),
            "Room": s["Room"],
            "Day": {"2026-10-20": "Tue 20 Oct", "2026-10-21": "Wed 21 Oct", "2026-10-22": "Thu 22 Oct", "2026-10-23": "Fri 23 Oct"}[day],
            "Time": t.replace(" - ", "–").replace("-", "–"),
            "Session Leaders": " / ".join(names),
        })

with OUT.open("w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
    w.writeheader(); w.writerows(out)
print(f"{len(out)} sessions with Session Leaders written to {OUT.relative_to(ROOT)}")
print(f"{sum(1 for o in out if not o['Session Leaders'])} with no leader named")
if skipped:
    print("Left out (not in the session list, e.g. cancelled):")
    for x in skipped: print("  " + x)
