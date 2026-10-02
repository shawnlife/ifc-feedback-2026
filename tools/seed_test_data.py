#!/usr/bin/env python3
"""
Fill the TEST tabs with realistic made-up feedback so the dashboard can be seen
populated ("Show test responses" ticked). Never touches the real tabs.
Remove afterwards with IFC Feedback > Clear test responses.

    python3 tools/seed_test_data.py            # ~350 responses, ~60 leader reports
"""
import csv, json, random, re, time, urllib.request, uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).parent.parent
API = re.search(r"apiUrl:\s*'([^']+)'", (ROOT / "config.js").read_text())[1]
rnd = random.Random(2026)
sessions = [s for s in csv.DictReader((ROOT / "sessions-ifc2026.csv").open(encoding="utf-8")) if s["Start"]]

TAKE = ["Test small before scaling anything", "Ask donors what they want, then actually listen", "The 70/20/10 budget split",
        "Retention beats acquisition every time", "Bring finance into the room early", "Consent comes before the story",
        "Use first-party data properly", "Legacy conversations should start earlier", "Partnerships need shared goals, not logos",
        "Short videos outperform long ones for us", "Measure what donors feel, not just what they give"]
BETTER = ["More time for questions", "The room was too warm", "Slides were hard to read from the back",
          "Fewer slides, more real examples", "Could have been longer", "Needed a microphone for audience questions"]
NAMES = ["Anna de Groot", "Ben Okoro", "Chen Wei", "Dana Levi", "Eva Lindqvist", "Femi Adeyemi"]
ISSUES = ["Projector failed for about 10 minutes", "Room far too small, people standing at the back", "Speaker ran 15 minutes over"]
NOTES = ["Packed room, great energy", "Lively Q&A, we ran out of time", "A few people left halfway through",
         "One of the speakers was outstanding", "Heated but respectful debate, worth a follow-up"]


def post(obj):
    req = urllib.request.Request(API, data=json.dumps(obj).encode(), headers={"Content-Type": "text/plain;charset=utf-8"})
    for attempt in range(6):                      # retry like a phone would
        try:
            j = json.loads(urllib.request.urlopen(req, timeout=60).read())
            if j.get("ok"):
                return True
        except Exception:
            pass
        time.sleep(2 + attempt * 3)
    return False


def sess(s):
    return {"id": s["ID"], "title": s["Title"], "speakers": s["Speakers"], "room": s["Room"],
            "date": s["Date"], "start": s["Start"], "end": s["End"], "track": s["Track"]}


items = []
for s in sessions:
    quality = rnd.uniform(3.0, 4.8)
    for _ in range(rnd.choice([0, 1, 2, 3, 3, 4, 5])):
        o = max(1, min(5, round(rnd.gauss(quality, 0.8))))
        items.append({"rid": "seed-" + uuid.uuid4().hex[:10], "test": True, "form": "attendee", "sentAt": "seed", "session": sess(s),
                      "answers": {"Overall (1-5)": o, "Speakers (1-5)": max(1, min(5, o + rnd.choice([-1, 0, 0, 1]))),
                                  "Relevance (1-5)": rnd.choice(["", max(1, min(5, o + rnd.choice([-1, 0, 1])))]),
                                  "Will apply": rnd.choices(["Yes, definitely", "Maybe", "No", ""], [o, 2, 0.5, 1])[0],
                                  "Key takeaway": rnd.choice(TAKE + [""] * 4), "Suggestions": rnd.choice(BETTER + [""] * 6),
                                  "Came from": rnd.choices(["QR code", "Link", "Home screen"], [7, 2, 1])[0]}})
    if rnd.random() < 0.45:
        o = rnd.randint(2, 5)
        items.append({"rid": "seed-" + uuid.uuid4().hex[:10], "test": True, "form": "leader", "sentAt": "seed", "session": sess(s),
                      "answers": {"Session Leader name": rnd.choice(NAMES), "Session Leader: Overall (1-5)": o,
                                  "Session Leader: Audience engagement (1-5)": max(1, min(5, o + rnd.choice([-1, 0, 1]))),
                                  "Session Leader: Content clarity (1-5)": max(1, min(5, o + rnd.choice([-1, 0, 1]))),
                                  "Session Leader: Key issues": rnd.choices(ISSUES + [""], [1, 1, 1, 14])[0],
                                  "Session Leader: Final comments": rnd.choice(NOTES), "Came from": "Link"}})
for typed in ["the one about legacies in the big room", "Matt Derby session", "Evening drinks talk"]:
    items.append({"rid": "seed-" + uuid.uuid4().hex[:10], "test": True, "form": "attendee", "sentAt": "seed",
                  "session": {"id": "NOT LISTED", "title": typed},
                  "answers": {"Overall (1-5)": 4, "Key takeaway": "Great session", "Came from": "QR code"}})
rnd.shuffle(items)
events = ["help"] * 3 + ["shawnlife"] * 2 + ["tip-shown"] * 40 + ["installed"] * 5

print(f"Sending {len(items)} test items + {len(events)} test clicks…")
with ThreadPoolExecutor(4) as ex:
    ok = list(ex.map(post, items))
    ex.map(lambda t: post({"action": "event", "type": t, "test": True}), events)
print(f"{sum(ok)} of {len(items)} saved. They appear in the dashboard within a minute (tick 'Show test responses').")
