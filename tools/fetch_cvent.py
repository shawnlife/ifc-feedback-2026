#!/usr/bin/env python3
"""
Pull the IFC 2026 programme from the public Cvent schedule page and write the
session list the feedback form uses.

    python3 tools/fetch_cvent.py

Writes:
  sample-data/cvent-all.json      everything on the page (169 items incl. meals, breaks)
  sessions-ifc2026.csv            only the sessions worth rating (import this into the Sheet)

Cvent's list view has no rooms, so this opens each session's pop-up to read the
room, session code and track. Takes about 3 minutes. Re-run it if the programme
changes before the event, then re-import the CSV into the Sessions tab.
"""

import csv
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = ("https://web-eur.cvent.com/event/e5186c7c-cbbe-4165-ba1a-caac19f99087/"
       "websitePage:2fba825d-173a-4fc7-8cf3-2388e3804d41?environment=production-eu")
ROOT = Path(__file__).parent.parent
MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july",
                                      "august", "september", "october", "november", "december"], 1)}

# Not things people give session feedback on
SKIP = re.compile(r"^(breakfast|lunch|dinner|buffet dinner|drinks reception|break|yoga|yin|sound bath|"
                  r"10 minute movement|mindfulness walk|speaker welcome|live stream test|pub quiz|gala|"
                  r"ifc welcome dinner|ifc online|arrival & registration|workshop tbc|welcome to ifc)", re.I)

GRAB = r"""async (i) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const names = [...document.querySelectorAll('[data-cvent-id="session-list-card-session-name"]')];
  const n = names[i]; n.scrollIntoView(); n.click();
  let d;
  for (let k = 0; k < 40; k++) {
    await sleep(150);
    d = document.querySelector('[data-cvent-id="session-detail-modal"]');
    if (d && d.closest('[role=dialog]').innerText.startsWith(n.title.slice(0, 10))) break;
  }
  const dlg = document.querySelector('[role="dialog"]');
  const pill = d.querySelector('[data-cvent-id^="session-modal-category-"]');
  const desc = d.querySelector('[data-cvent-id="session-modal-description-session-description"]');
  const pre = desc ? d.innerText.split(desc.innerText.slice(0, 30))[0] : d.innerText;
  const lines = pre.split('\n').map(s => s.trim()).filter(s => s && s !== '|');
  const tm = lines.find(s => /\d\d:\d\d-\d\d:\d\d/.test(s)) || '';
  const rest = lines.slice(lines.indexOf(tm) + 1).filter(s => !pill || s !== pill.innerText.trim());
  const track = dlg.innerText.match(/\nTrack\n+([^\n]+)/);
  const speakers = [...dlg.querySelectorAll('[data-cvent-id="speaker-info"]')].map(s => ({
    name: ((s.querySelector('[data-cvent-id="speaker-name"]') || {}).innerText || '').trim(),
    org: ((s.querySelector('[data-cvent-id="speaker-card-speaker-info-speaker-company"]') || {}).innerText || '').trim()
  }));
  const row = { title: n.title.replace(/\s+/g, ' ').trim(), date: lines[0], time: tm,
                type: pill ? pill.innerText.trim() : '', rest, track: track ? track[1].trim() : '', speakers };
  dlg.querySelector('[data-cvent-id="close"]').click();
  await sleep(250);
  return row;
}"""


def iso(date_text):
    m = re.match(r"(\d{1,2}) (\w+) (\d{4})", date_text)
    return f"{m[3]}-{MONTHS[m[2].lower()]:02d}-{int(m[1]):02d}" if m else ""


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1280, "height": 900})
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector('[data-cvent-id="session-list-card-session-name"]', timeout=60000)
        for _ in range(40):  # the list loads more as you scroll
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(600)
        total = page.locator('[data-cvent-id="session-list-card-session-name"]').count()
        print(f"{total} items on the schedule, reading each one…")
        rows = [page.evaluate(GRAB, i) for i in range(total)]
        b.close()

    (ROOT / "sample-data" / "cvent-all.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False))

    out, skipped = [], []
    for r in rows:
        if SKIP.match(r["title"]):
            skipped.append(r["title"])
            continue
        room, code = "", ""
        for part in r["rest"]:
            if re.fullmatch(r"\d?[A-Z]{2,3}\d{1,2}", part):  # 1WS14, TMC5, WMC11
                code = part
            elif not room:
                room = part
        start, end = (re.findall(r"\d\d:\d\d", r["time"]) + ["", ""])[:2]
        out.append({
            "ID": code,
            "Title": r["title"],
            "Speakers": ", ".join(s["name"] for s in r["speakers"] if s["name"]),
            "Organisations": ", ".join(dict.fromkeys(s["org"] for s in r["speakers"] if s["org"])),
            "Room": room,
            "Date": iso(r["date"]),
            "Start": start,
            "End": end,
            "Track": r["track"] if r["track"] not in ("", "Masterclass") else (r["type"] or r["track"]),
            "Type": r["type"],
        })

    path = ROOT / "sessions-ifc2026.csv"
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0]))
        w.writeheader()
        w.writerows(out)
    print(f"Wrote {len(out)} rateable sessions to {path.name}")
    print(f"Left out {len(skipped)}: " + ", ".join(sorted(set(skipped))))
    for r in out:
        if not r["Room"] or not r["ID"]:
            print("  check:", r["Date"], r["Start"], r["Title"], "| room:", r["Room"] or "MISSING", "| code:", r["ID"] or "none")


if __name__ == "__main__":
    main()
