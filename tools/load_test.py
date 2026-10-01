#!/usr/bin/env python3
"""
Load test: simulate a session block ending, with many phones submitting at once.
Writes ONLY to the "Test responses" tab (test: true).

    python3 tools/load_test.py 300 40       # 300 responses, 40 at the same moment
"""
import csv, json, random, sys, time, uuid, urllib.request, re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).parent.parent
API = re.search(r"apiUrl:\s*'([^']+)'", (ROOT / "config.js").read_text())[1]
N, CONC = int(sys.argv[1]) if len(sys.argv) > 1 else 300, int(sys.argv[2]) if len(sys.argv) > 2 else 40
sessions = list(csv.DictReader((ROOT / "sessions-ifc2026.csv").open(encoding="utf-8")))
RUN = time.strftime("%H%M%S")


def one(i):
    s = random.choice(sessions)
    item = {"rid": f"load-{RUN}-{i}-{uuid.uuid4().hex[:6]}", "test": True, "sentAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "session": {"id": s["ID"], "title": s["Title"], "speakers": s["Speakers"], "room": s["Room"], "date": s["Date"],
                        "start": s["Start"], "end": s["End"], "track": s["Track"]},
            "answers": {"Overall (1-5)": random.randint(2, 5), "Speakers (1-5)": random.randint(2, 5),
                        "Key takeaway": f"LOAD TEST {RUN} #{i}", "Came from": "Load test"}}
    t = time.time()
    try:
        req = urllib.request.Request(API, data=json.dumps(item).encode(), headers={"Content-Type": "text/plain;charset=utf-8"})
        j = json.loads(urllib.request.urlopen(req, timeout=60).read())
        return (bool(j.get("ok")), time.time() - t, "" if j.get("ok") else str(j)[:120], item)
    except Exception as e:
        return (False, time.time() - t, f"{type(e).__name__}: {str(e)[:100]}", item)


t0 = time.time()
with ThreadPoolExecutor(CONC) as ex:
    res = list(ex.map(one, range(N)))
dur = time.time() - t0
ok = [r for r in res if r[0]]
lat = sorted(r[1] for r in res)
print(f"{N} responses, {CONC} at once, run {RUN}: {len(ok)} saved first time, {N - len(ok)} failed, {dur:.0f}s total")
print(f"time per response: median {lat[len(lat)//2]:.1f}s, 95% under {lat[int(len(lat)*.95)]:.1f}s, slowest {lat[-1]:.1f}s")
errs = {}
for r in res:
    if not r[0]: errs[r[2]] = errs.get(r[2], 0) + 1
for e, c in errs.items(): print(f"  {c} x {e}")

# Phones retry failures; do the same, and resend some successes to check duplicates are ignored
retry = [r[3] for r in res if not r[0]] + [r[3] for r in ok[:20]]
if retry:
    with ThreadPoolExecutor(10) as ex:
        res2 = list(ex.map(lambda it: one.__wrapped__(it) if hasattr(one, "__wrapped__") else None, []))
    def resend(item):
        try:
            req = urllib.request.Request(API, data=json.dumps(item).encode(), headers={"Content-Type": "text/plain;charset=utf-8"})
            return json.loads(urllib.request.urlopen(req, timeout=60).read())
        except Exception as e:
            return {"ok": False, "error": str(e)}
    with ThreadPoolExecutor(10) as ex:
        res2 = list(ex.map(resend, retry))
    print(f"retry round: {sum(1 for j in res2 if j.get('ok'))}/{len(res2)} ok, "
          f"{sum(1 for j in res2 if j.get('duplicate'))} recognised as duplicates")
print("RUN", RUN)
