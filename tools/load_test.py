#!/usr/bin/env python3
"""
Load test: simulate a session block ending with many phones submitting at once,
then prove every response reached the Sheet. Writes ONLY to "Test responses".

    python3 tools/load_test.py 800 100 '<dashboard password>'

  1. fires N responses, C at the same moment
  2. retries anything that failed the way a phone does (3 s, 6 s, 12 s ... with random spacing)
  3. asks the dashboard for the Test responses tab and checks every one is there, exactly once
Afterwards: IFC Feedback > Clear test responses.
"""
import csv, json, random, re, sys, time, uuid, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).parent.parent
API = re.search(r"apiUrl:\s*'([^']+)'", (ROOT / "config.js").read_text())[1]
N = int(sys.argv[1]) if len(sys.argv) > 1 else 800
CONC = int(sys.argv[2]) if len(sys.argv) > 2 else 100
KEY = sys.argv[3] if len(sys.argv) > 3 else ""
PERMANENT = {"invalid", "too large", "empty", "no answers"}
CFGTXT = (ROOT / "config.js").read_text()
FB_PROJECT = (re.search(r"projectId:\s*'([^']*)'", CFGTXT) or [None, ""])[1]
FB_KEY = (re.search(r"apiKey:\s*'([^']*)'", CFGTXT) or [None, ""])[1]
via = {"firebase": 0, "sheet": 0}
sessions = list(csv.DictReader((ROOT / "sessions-ifc2026.csv").open(encoding="utf-8")))
RUN = "LT" + time.strftime("%H%M%S")


def post(obj, timeout=45):
    req = urllib.request.Request(API, data=json.dumps(obj).encode(), headers={"Content-Type": "text/plain;charset=utf-8"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def make(i):
    s = random.choice(sessions)
    return {"rid": f"{RUN}-{i}-{uuid.uuid4().hex[:6]}", "test": True,
            "sentAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "session": {"id": s["ID"], "title": s["Title"], "speakers": s["Speakers"], "room": s["Room"],
                        "date": s["Date"], "start": s["Start"], "end": s["End"], "track": s["Track"]},
            "answers": {"Overall (1-5)": random.randint(2, 5), "Speakers (1-5)": random.randint(2, 5),
                        "Key takeaway": f"{RUN} #{i}", "Came from": "Load test"}}


def to_fs(v):
    if isinstance(v, bool): return {"booleanValue": v}
    if isinstance(v, int): return {"integerValue": str(v)}
    if isinstance(v, dict): return {"mapValue": {"fields": {k: to_fs(x) for k, x in v.items()}}}
    if v is None: return {"nullValue": None}
    return {"stringValue": str(v)}


def send_firebase(item):
    """Exactly what a phone does: create-only write, ID = rid, server timestamp."""
    docs = f"https://firestore.googleapis.com/v1/projects/{FB_PROJECT}/databases/(default)/documents"
    body = {"writes": [{"update": {"name": f"projects/{FB_PROJECT}/databases/(default)/documents/responses/{item['rid']}",
                                   "fields": to_fs({k: item[k] for k in ("rid", "test", "sentAt", "session", "answers")} | {"v": 1})["mapValue"]["fields"]},
                        "currentDocument": {"exists": False},
                        "updateTransforms": [{"fieldPath": "received", "setToServerValue": "REQUEST_TIME"}]}]}
    req = urllib.request.Request(f"{docs}:commit?key={FB_KEY}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=15).read()
        return True
    except urllib.error.HTTPError as e:
        txt = e.read().decode()[:300]
        if e.code == 409 or "ALREADY_EXISTS" in txt or "FAILED_PRECONDITION" in txt:
            return True
        raise RuntimeError(f"firebase {e.code} {txt[:120]}")


def send(item):
    t = time.time()
    if FB_PROJECT and FB_KEY:
        try:
            if send_firebase(item):
                via["firebase"] += 1
                return "ok", time.time() - t, ""
        except Exception as e:
            errors_fb[str(e)[:90]] = errors_fb.get(str(e)[:90], 0) + 1   # fall back to the Sheet route, like a phone
    try:
        j = post(item)
        if j.get("ok"): via["sheet"] += 1
        if j.get("ok"):
            return "ok", time.time() - t, ""
        return ("rejected" if j.get("error") in PERMANENT else "busy"), time.time() - t, str(j.get("error"))[:80]
    except Exception as e:
        return "failed", time.time() - t, type(e).__name__ + ": " + str(e)[:60]


errors_fb = {}
items = [make(i) for i in range(N)]
pending = list(range(N))
attempts = {i: 0 for i in range(N)}
first_lat, errors = [], {}
t0 = time.time()
for rnd, wait in enumerate([0, 3, 6, 12, 20, 30, 45, 60, 60, 60]):
    if not pending:
        break
    if wait:
        time.sleep(wait * random.uniform(0.6, 1.4))
    with ThreadPoolExecutor(CONC) as ex:
        res = list(ex.map(lambda i: (i, send(items[i])), pending))
    still = []
    for i, (st, lat, err) in res:
        attempts[i] += 1
        if rnd == 0:
            first_lat.append(lat)
        if st != "ok":
            errors[err or st] = errors.get(err or st, 0) + 1
            if st != "rejected":
                still.append(i)
    print(f"round {rnd + 1}: sent {len(pending)}, {len(pending) - len(still)} accepted, {len(still)} to retry  ({time.time() - t0:.0f}s)")
    pending = still

lat = sorted(first_lat)
print(f"\n{N} responses, {CONC} at the same moment ({RUN})")
print(f"first try: {sum(1 for i in range(N) if attempts[i] == 1 and i not in pending)} accepted straight away")
print(f"time to answer on first try: median {lat[len(lat)//2]:.1f}s, 95% under {lat[int(len(lat)*.95)]:.1f}s, slowest {lat[-1]:.1f}s")
print(f"needed retries: {sum(1 for a in attempts.values() if a > 1)}, never accepted: {len(pending)}")
for e, c in sorted(errors.items(), key=lambda x: -x[1]):
    print(f"  {c} x {e}")
print(f"route used: {via}" + (f"; Firebase errors before falling back: {errors_fb}" if errors_fb else ""))

if KEY:
    print("\nChecking the Sheet (dashboard also triggers processing)…")
    for k in range(12):
        time.sleep(30 if k else 5)
        d = post({"action": "dashboard", "key": KEY, "test": True}, timeout=120)
        found = [r for r in d.get("responses", []) if str(r.get("Key takeaway", "")).startswith(RUN + " #")]
        nums = [int(str(r["Key takeaway"]).split("#")[1]) for r in found]
        print(f"  {len(set(nums))} of {N} in Test responses, {len(nums) - len(set(nums))} duplicates, raw log waiting: {d.get('health', {}).get('waiting')}")
        if len(set(nums)) >= N - len(pending):
            break
    missing = sorted(set(range(N)) - set(nums))
    print("RESULT:", "EVERY RESPONSE ARRIVED, NO DUPLICATES" if not missing and len(nums) == len(set(nums)) else f"MISSING {missing[:20]}")
