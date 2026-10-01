#!/usr/bin/env python3
"""
Build the session list from James's Facility Management sheet (the most up to
date source for WHAT happens WHERE and WHEN), enriched with the Cvent data
(official speaker spellings, organisations, tracks, session codes).

    python3 tools/build_from_fm.py

Reads:  source/IFC 2026 - Facility Management Sheet - JT(FM Sheet).csv   (private, not in git)
        sample-data/cvent-all.json   (from tools/fetch_cvent.py)
Writes: sessions-ifc2026.csv         (import into the Sessions tab)
        source/fm-vs-cvent-report.txt (every difference, for checking)
"""

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
FM = next((ROOT / "source").glob("*Facility Management*.csv"))
DAYS = {"tuesday": "2026-10-20", "wednesday": "2026-10-21", "thursday": "2026-10-22", "friday": "2026-10-23"}

# Things nobody gives session feedback on (or Shawn asked to leave out)
SKIP = re.compile(r"(set ?up|^welcome to ifc|plenary|pub quiz|dinner|drinks|reception|gala|disco|dressing|"
                  r"meeting room|speaker briefing|film screening|^atrium set)", re.I)


def norm(s):
    s = s.lower().replace("’", "'").replace("…", "...")
    s = re.sub(r"^masterclass( tuesday| wednesday)?\s*:?\s*", "", s.strip())
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def clean_room(r):
    r = re.split(r"\s+-\s+|\(|/", r)[0]
    return re.sub(r"\s+", " ", r).strip()


def clean_title(t):
    t = re.sub(r"\s*/\s*$", "", t.replace("\n", " ")).strip()
    return re.sub(r"\s+", " ", t)


def clean_speakers(s):
    s = re.sub(r"\s*/\s*", " ", s.replace("\n", " ")).strip()
    return ", ".join(p.strip() for p in re.split(r",|&", s) if p.strip())


# ---- Cvent, indexed by (date, start, normalised title)
cvent = {}
for r in json.loads((ROOT / "sample-data" / "cvent-all.json").read_text()):
    m = re.match(r"(\d{1,2}) October 2026", r.get("date") or "")
    if not m:
        continue
    date = f"2026-10-{int(m[1]):02d}"
    start = (re.findall(r"\d\d:\d\d", r["time"]) or [""])[0]
    code = next((p for p in r["rest"] if re.fullmatch(r"\d?[A-Z]{2,3}\d{1,2}", p)), "")
    room = next((p for p in r["rest"] if p != code), "")
    cvent[(date, start, norm(r["title"]))] = dict(r, code=code, room=room, used=False)

# ---- James's sheet
rows = list(csv.reader(FM.open(encoding="cp1252")))
out, report, skipped = [], [], []
for line, r in enumerate(rows[1:], 2):
    room_raw, day, time, title_raw, spk_raw = (r + [""] * 5)[:5]
    title = clean_title(title_raw)
    dkey = day.strip().split(" ")[0].lower()
    if not title or dkey not in DAYS:
        continue
    times = re.findall(r"\d{1,2}[:.]\d\d", time)
    if len(times) < 2 or SKIP.search(title):
        skipped.append(f"{day} {time} {title}")
        continue
    date = DAYS[dkey]
    start, end = (t.replace(".", ":").zfill(5) for t in times[:2])
    room = clean_room(room_raw)
    speakers = clean_speakers(spk_raw)
    if title.lower().startswith("open discussion"):
        title = "Open Discussion"
    elif title.lower().startswith("leadership summit"):
        title = "Leadership Summit" + (" breakout" if "breakout" in title.lower() else "")

    # Leadership Summit: one entry; the breakouts in Boston 11-17 are part of it
    if title == "Leadership Summit breakout":
        skipped.append(f"{day} {time} {title} (folded into Leadership Summit)")
        continue
    if title == "Leadership Summit":
        room = "Boston 9 (breakouts Boston 11, 13, 15, 17)"

    c = cvent.get((date, start, norm(title)))
    row = {"ID": "", "Title": title, "Speakers": speakers, "Organisations": "", "Room": room,
           "Date": date, "Start": start, "End": end, "Track": "", "Type": ""}
    if c:
        c["used"] = True
        row["ID"] = c["code"]
        row["Speakers"] = ", ".join(s["name"] for s in c["speakers"]) or speakers   # official spellings
        row["Organisations"] = ", ".join(dict.fromkeys(s["org"] for s in c["speakers"] if s["org"]))
        row["Track"] = c["track"] if c["track"] not in ("", "Masterclass") else (c["type"] or c["track"])
        row["Type"] = c["type"]
        if c["room"] and c["room"].lower() != room.lower():
            report.append(f"ROOM   {date} {start} {title}: James says {room}, Cvent says {c['room']}")
        fm_names = {n.lower() for n in re.split(r",\s*", speakers) if n}
        cv_names = {s['name'].lower() for s in c['speakers']}
        if fm_names and fm_names != cv_names:
            report.append(f"NAMES  {date} {start} {title}: James '{speakers}' / Cvent '{row['Speakers']}' (using Cvent)")
    else:
        if title.startswith("Innovation Hub"):
            row["Type"] = "Innovation Hub"
        elif title.startswith("BIG TOPIC"):
            row["Type"] = "Big Topic"
        report.append(f"NEW    {date} {start} {room}: {title}" + (f" ({speakers})" if speakers else "") +
                      "  [not in Cvent]")
    # Cvent's "Workshop TBC" placeholders, now named in James's sheet
    tbc_codes = {("2026-10-22", "09:00", "Erasmus 3"): "2WS5", ("2026-10-22", "15:00", "Boston 17"): "5WS4",
                 ("2026-10-23", "09:30", "Boston 9"): "7WS12"}
    if (date, start, room) in tbc_codes:
        row["ID"] = tbc_codes[(date, start, room)]
        cv = next(v for v in cvent.values() if v["code"] == row["ID"])
        cv["used"] = True
        report = [x for x in report if not x.startswith(f"NEW    {date} {start} {room}")]
    if "tbc" in title.lower() or title == "Open Discussion":
        report.append(f"TBC    {date} {start} {room}: {title}")
    out.append(row)

for c in cvent.values():
    if not c["used"] and c["code"]:
        report.append(f"GONE   {c['date']} {c['time']} {c['title']} ({c['code']}): in Cvent but not in James's sheet")

# Sessions not in Cvent get a fixed ID from day, time and room, e.g. N22-0900-ERA3, so
# filling in a TBC title later does not change the ID.
for row in out:
    if not row["ID"]:
        room_code = re.sub(r"[^A-Z0-9]", "", (row["Room"].split("(")[0][:3].upper() + re.sub(r"\D", "", row["Room"].split("(")[0])))
        row["ID"] = f"N{row['Date'][-2:]}-{row['Start'].replace(':', '')}-{room_code}"

out.sort(key=lambda x: (x["Date"], x["Start"], x["Room"]))
with (ROOT / "sessions-ifc2026.csv").open("w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(out[0]))
    w.writeheader()
    w.writerows(out)
(ROOT / "source" / "fm-vs-cvent-report.txt").write_text("\n".join(sorted(report)) + "\n\nLEFT OUT:\n" + "\n".join(skipped))
print(f"{len(out)} sessions written. {len(report)} report lines, {len(skipped)} left out.")
