#!/usr/bin/env python3
"""
Full rehearsal: realistic feedback for every session from Wednesday morning up to a
cut-off time (default Thursday 11:00, conference time), sent the way phones send it
(Firebase first). Everything is TEST data with pretend send times, so the dashboard
(with "Show test responses" ticked) looks like the conference is under way.

    python3 tools/rehearsal.py                 # up to Thu 22 Oct 11:00
    python3 tools/rehearsal.py 2026-10-21T18:00

Remove afterwards with IFC Feedback > Clear test responses.
"""
import csv, json, random, re, sys, time, uuid, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).parent.parent
CFG = (ROOT / "config.js").read_text()
API = re.search(r"apiUrl:\s*'([^']+)'", CFG)[1]
FB_PROJECT = re.search(r"projectId:\s*'([^']*)'", CFG)[1]
FB_KEY = re.search(r"apiKey:\s*'([^']*)'", CFG)[1]
CUTOFF = datetime.fromisoformat(sys.argv[1] if len(sys.argv) > 1 else "2026-10-22T11:00")
rnd = random.Random(21)
LOCAL_OFFSET = timedelta(hours=2)            # Netherlands summer time until 25 Oct

sessions = [s for s in csv.DictReader((ROOT / "sessions-ifc2026.csv").open(encoding="utf-8")) if s["Start"]]
at = lambda s, f: datetime.fromisoformat(f"{s['Date']}T{s[f] or s['Start']}")

TAKE = ["Test small before scaling anything", "Ask donors what they want, then actually listen", "The 70/20/10 budget split",
        "Retention beats acquisition", "Bring finance into the room early", "Consent comes before the story",
        "Partnerships need shared goals, not logos", "Measure how donors feel, not just what they give",
        "Our legacy messaging is far too late in the journey", "Stop treating digital as a separate team",
        "Power-sharing has to show up in budgets, not just language", "Great examples from Kenya and the Philippines"]
GOOD = ["More time for questions please", "Would love the slides shared afterwards", "Could easily have been longer",
        "Room was a bit warm", "Needed a microphone for audience questions"]
BAD = ["Speaker mostly read from the slides", "Too theoretical, not enough practical examples", "Started 10 minutes late and rushed the end",
       "Felt like a sales pitch for their agency", "Couldn't hear at the back", "Content was very basic for this audience"]
SL_NAMES = ["Anna de Groot", "Ben Okoro", "Chen Wei", "Dana Levi", "Eva Lindqvist", "Femi Adeyemi", "Grace Mwangi", "Hugo Bakker"]
SL_ISSUES = ["Projector failed for about 10 minutes", "Room far too small, people standing at the back",
             "Speaker ran 15 minutes over", "Mic kept cutting out"]
SL_NOTES = ["Packed room, great energy throughout", "Lively Q&A, we ran out of time", "A few people left halfway through",
            "One of the speakers was outstanding", "Heated but respectful debate, worth a follow-up session",
            "Quiet room, audience seemed tired after lunch"]


def iso(local):
    return (local - LOCAL_OFFSET).strftime("%Y-%m-%dT%H:%M:%SZ")


def delay_after_end(next_morning):
    r = rnd.random()
    if r < 0.08: return timedelta(minutes=-rnd.randint(1, 20))        # left early
    if r < 0.63: return timedelta(minutes=rnd.randint(0, 15))
    if r < 0.83: return timedelta(minutes=rnd.randint(15, 60))
    if r < 0.93: return timedelta(minutes=rnd.randint(60, 240))
    return next_morning


def sess(s):
    return {"id": s["ID"], "title": s["Title"], "speakers": s["Speakers"], "room": s["Room"],
            "date": s["Date"], "start": s["Start"], "end": s["End"], "track": s["Track"]}


items = []
for s in sessions:
    start, end = at(s, "Start"), at(s, "End")
    if start >= CUTOFF:
        continue
    masterclass = s["Title"].startswith("Masterclass")
    discussion = s["Title"].startswith("Open Discussion")
    people = rnd.randint(14, 22) if masterclass else rnd.randint(12, 25) if discussion else rnd.randint(30, 60)
    rate = 0.45 if masterclass else 0.3
    quality = rnd.uniform(2.6, 4.8) if rnd.random() > 0.08 else rnd.uniform(1.8, 2.5)    # a few genuinely poor ones
    next_morning = datetime.fromisoformat(s["Date"] + "T08:00") + timedelta(days=1) - end
    for _ in range(sum(rnd.random() < rate for _ in range(people))):
        when = end + delay_after_end(next_morning + timedelta(minutes=rnd.randint(0, 50)))
        if end > CUTOFF:                                    # still running at the cut-off: only a few early leavers
            if rnd.random() > 0.07:
                continue
            when = start + timedelta(minutes=rnd.randint(10, max(11, int((CUTOFF - start).total_seconds() // 60))))
        if when > CUTOFF or when < start:
            continue
        o = max(1, min(5, round(rnd.gauss(quality, 0.75))))
        src = rnd.choices(["QR code", "NFC tag", "Link", "Home screen"], [45, 30, 15, 6 if s["Date"] < "2026-10-22" else 14])[0]
        items.append({"rid": "sim-" + uuid.uuid4().hex[:12], "test": True, "form": "attendee", "sentAt": iso(when), "session": sess(s),
                      "answers": {"Overall (1-5)": o, "Speakers (1-5)": max(1, min(5, o + rnd.choice([-1, 0, 0, 1]))),
                                  "Relevance (1-5)": rnd.choice(["", max(1, min(5, o + rnd.choice([-1, 0, 1])))]),
                                  "Will apply": rnd.choices(["Yes, definitely", "Maybe", "No", ""], [o * 1.2, 2, 3 - o * 0.5 if o < 4 else 0.3, 1])[0],
                                  "Key takeaway": rnd.choice(TAKE + [""] * 5) if o >= 3 else rnd.choice([""] * 3 + TAKE[:3]),
                                  "Suggestions": rnd.choice(GOOD + [""] * 6) if o >= 4 else rnd.choice(BAD + GOOD[:2] + [""] * 2),
                                  "Came from": src}})
    # Session Leader reports (sometimes two, who don't always agree)
    if end <= CUTOFF and rnd.random() < 0.8:
        for k in range(2 if rnd.random() < 0.18 else 1):
            o = max(1, min(5, round(quality + rnd.choice([-1, 0, 0, 1]) + (rnd.choice([-2, 2]) if k else 0))))
            items.append({"rid": "sim-" + uuid.uuid4().hex[:12], "test": True, "form": "leader", "sentAt": iso(end + timedelta(minutes=rnd.randint(3, 45))),
                          "session": sess(s),
                          "answers": {"Session Leader name": rnd.choice(SL_NAMES), "Session Leader: Overall (1-5)": o,
                                      "Session Leader: Audience engagement (1-5)": max(1, min(5, o + rnd.choice([-1, 0, 1]))),
                                      "Session Leader: Content clarity (1-5)": max(1, min(5, o + rnd.choice([-1, 0, 1]))),
                                      "Session Leader: Key issues": rnd.choices(SL_ISSUES + [""], [1, 1, 1, 1, 28])[0],
                                      "Session Leader: Final comments": rnd.choice(SL_NOTES), "Came from": "Link"}})
for typed, when in [("Matt Derby talk", "2026-10-22T10:20"), ("the drinks thing last night", "2026-10-22T08:40"),
                    ("open discussion about wellbeing", "2026-10-21T18:10"), ("The AI one", "2026-10-21T16:55")]:
    items.append({"rid": "sim-" + uuid.uuid4().hex[:12], "test": True, "form": "attendee", "sentAt": iso(datetime.fromisoformat(when)),
                  "session": {"id": "NOT LISTED", "title": typed},
                  "answers": {"Overall (1-5)": rnd.randint(3, 5), "Key takeaway": rnd.choice(TAKE), "Came from": "QR code"}})


def to_fs(v):
    if isinstance(v, bool): return {"booleanValue": v}
    if isinstance(v, int): return {"integerValue": str(v)}
    if isinstance(v, dict): return {"mapValue": {"fields": {k: to_fs(x) for k, x in v.items()}}}
    return {"stringValue": str(v)}


def send(item):
    body = {"writes": [{"update": {"name": f"projects/{FB_PROJECT}/databases/(default)/documents/responses/{item['rid']}",
                                   "fields": to_fs(dict(item, v=1))["mapValue"]["fields"]},
                        "currentDocument": {"exists": False},
                        "updateTransforms": [{"fieldPath": "received", "setToServerValue": "REQUEST_TIME"}]}]}
    url = f"https://firestore.googleapis.com/v1/projects/{FB_PROJECT}/databases/(default)/documents:commit?key={FB_KEY}"
    for attempt in range(5):
        try:
            urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}), timeout=20).read()
            return True
        except urllib.error.HTTPError as e:
            if e.code == 409: return True
        except Exception:
            pass
        time.sleep(2 + attempt * 2)
    return False


def event(t):
    req = urllib.request.Request(API, data=json.dumps({"action": "event", "type": t, "test": True}).encode(), headers={"Content-Type": "text/plain"})
    try: urllib.request.urlopen(req, timeout=60).read()
    except Exception: pass


att = [i for i in items if i["form"] == "attendee"]
print(f"Rehearsal up to {CUTOFF:%a %d %b %H:%M}: {len(att)} attendee responses, {len(items) - len(att)} Session Leader reports")
with ThreadPoolExecutor(20) as ex:
    ok = list(ex.map(send, items))
print(f"{sum(ok)} of {len(items)} saved in Firebase.")
clicks = ["help"] * 5 + ["shawnlife"] * 3 + ["installed"] * 14 + ["tip-shown"] * int(len(att) * 0.7)
with ThreadPoolExecutor(3) as ex:
    list(ex.map(event, clicks))
print(f"{len(clicks)} test clicks sent. Open the dashboard (Show test responses) to pull it all in.")
