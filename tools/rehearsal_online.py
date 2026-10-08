#!/usr/bin/env python3
"""
Made-up IFC Online feedback (as if sent from ifc2026survey.com/online) for every online
session in config.js, so the dashboard's IFC Online tab can be seen filled in.
TEST data only ("Show test responses"). Remove with IFC Feedback > Clear test responses.

    python3 tools/rehearsal_online.py
"""
import csv, json, random, re, uuid, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).parent.parent
CFG = (ROOT / "config.js").read_text()
FB_PROJECT = re.search(r"projectId:\s*'([^']*)'", CFG)[1]
FB_KEY = re.search(r"apiKey:\s*'([^']*)'", CFG)[1]
ONLINE = re.findall(r"'([^']+)'", re.search(r"online:\s*{[^}]*sessions:\s*\[([^\]]*)\]", CFG, re.S)[1])
LOCAL_OFFSET = timedelta(hours=2)                       # Netherlands summer time
rnd = random.Random(2210)

sessions = {s["ID"]: s for s in csv.DictReader((ROOT / "sessions-ifc2026.csv").open(encoding="utf-8"))}
GOOD = ["Great stream quality, felt like being in the room", "Loved that online questions were taken", "Really practical, thank you",
        "Would watch this speaker again", "Slides were easy to read on the stream", ""]
BAD = ["Audio dropped out for a few minutes", "Camera stayed on the speaker, couldn't see the slides",
       "Online questions were never picked up", "Stream started late", "Felt like it was made for the room, not for us online"]
NAMES = ["Ana Lima (test)", "Kofi Boateng (test)", "Meera Iyer (test)", "Jakob Weber (test)"]


def fs(v):
    if isinstance(v, bool): return {"booleanValue": v}
    if isinstance(v, int): return {"integerValue": str(v)}
    if isinstance(v, float): return {"doubleValue": v}
    if isinstance(v, dict): return {"mapValue": {"fields": {k: fs(x) for k, x in v.items()}}}
    return {"stringValue": str(v)}


items = []
for sid in ONLINE:
    s = sessions.get(sid)
    if not s:
        print("not in the session list:", sid); continue
    quality = rnd.uniform(3.0, 4.7)
    names = [n.strip() for n in s["Speakers"].split(",") if n.strip()]
    end = datetime.fromisoformat(f"{s['Date']}T{s['End'] or s['Start']}")
    for _ in range(rnd.randint(12, 22) if sid.startswith("KEY") else rnd.randint(4, 14)):   # keynotes draw bigger audiences
        o = max(1, min(5, round(rnd.gauss(quality, 0.8))))
        per = {n: max(1, min(5, o + rnd.choice([-1, 0, 0, 1]))) for n in names}
        ans = {"Overall (1-5)": o,
               "Speakers (1-5)": round(sum(per.values()) / len(per), 1) if per else "",
               "Speaker ratings": "; ".join(f"{n}: {v}" for n, v in per.items()),
               "Relevance (1-5)": max(1, min(5, o + rnd.choice([-1, 0, 1]))),
               "Learned something new": rnd.choices(["Yes", "No", "Not sure"], [o, 2, 1])[0],
               "Anything else": rnd.choice(GOOD) if o >= 4 else rnd.choice(BAD + [""]),
               "Came from": "Link", "Format": "Online"}
        if rnd.random() < 0.06:
            nm = rnd.choice(NAMES)
            ans.update({"Contact me": "Yes", "Contact name": nm, "Contact email": nm.split(" (")[0].lower().replace(" ", ".") + "@example.org"})
        when = end + timedelta(minutes=rnd.randint(0, 45))
        items.append({"rid": "sim-" + uuid.uuid4().hex[:12], "test": True, "form": "attendee", "v": 1,
                      "sentAt": (when - LOCAL_OFFSET).strftime("%Y-%m-%dT%H:%M:%SZ"),
                      "session": {"id": s["ID"], "title": s["Title"], "speakers": s["Speakers"], "room": s["Room"],
                                  "date": s["Date"], "start": s["Start"], "end": s["End"], "track": s["Track"]},
                      "answers": ans})


def send(item):
    body = {"writes": [{"update": {"name": f"projects/{FB_PROJECT}/databases/(default)/documents/responses/{item['rid']}",
                                   "fields": fs(item)["mapValue"]["fields"]},
                        "currentDocument": {"exists": False},
                        "updateTransforms": [{"fieldPath": "received", "setToServerValue": "REQUEST_TIME"}]}]}
    url = f"https://firestore.googleapis.com/v1/projects/{FB_PROJECT}/databases/(default)/documents:commit?key={FB_KEY}"
    try:
        urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}), timeout=20).read()
        return True
    except urllib.error.HTTPError as e:
        return e.code == 409


with ThreadPoolExecutor(10) as ex:
    ok = list(ex.map(send, items))
print(f"{sum(ok)} of {len(items)} online test responses saved in Firebase, across {len(ONLINE)} online sessions.")
