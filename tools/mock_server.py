#!/usr/bin/env python3
"""
Local test server: serves the form and pretends to be the Google Apps Script
backend, so you can test end to end without touching the real Sheet.

    python3 tools/mock_server.py            # then open http://localhost:8765

/exec?action=sessions   returns the sample CSV as JSON, like the real backend
POST /exec              stores the response in memory; GET /_received lists them
POST /_fail?on=1        makes /exec fail (simulates no signal); ?on=0 to recover
POST /exec {"action":"dashboard","key":"test-password"}   dashboard data (password: test-password)

    MOCK_SESSIONS=sessions-ifc2026.csv MOCK_FAKE=900 python3 tools/mock_server.py 8767
        real programme + 900 made-up responses, for working on the dashboard
"""

import csv
import json
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
received, state, events, assigned = [], {"fail": False}, [], {}
DASH_KEY = "test-password"


def load_sessions():
    with (ROOT / os.environ.get("MOCK_SESSIONS", "sample-data/sessions-sample.csv")).open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def to_row(item, when=None):
    """Shape a posted response the way the Apps Script stores it (one row per response)."""
    s = item["session"]
    row = {"Timestamp": when or item.get("sentAt"), "Session ID": s.get("id", ""), "Session": s.get("title", ""),
           "Speakers": s.get("speakers", ""), "Room": s.get("room", ""), "Date": s.get("date", ""),
           "Time": "–".join(x for x in [s.get("start", ""), s.get("end", "")] if x), "Track": s.get("track", ""),
           "Note": "Typed in by attendee" if s.get("id") == "NOT LISTED" else ""}
    row.update(item["answers"])
    return row


def fake_rows(n):
    """Believable made-up responses so the dashboard can be designed before the event."""
    import random
    from datetime import datetime, timedelta
    rnd = random.Random(7)
    sess = [x for x in load_sessions() if x.get("Start")]
    take = ["Test small before scaling", "Ask donors what they want, then listen", "The 70/20/10 budget split",
            "Retention beats acquisition", "Bring finance into the room early", "Stories need consent first",
            "Use first-party data properly", "Legacy conversations start earlier than we think", ""]
    better = ["More time for questions", "Room was too warm", "Slides were hard to read from the back",
              "Fewer slides, more examples", "", "", "", "Could have been longer"]
    rows = []
    for s in sess:
        quality = rnd.uniform(3.2, 4.8)
        for _ in range(rnd.randint(0, 2 * n // len(sess))):
            o = max(1, min(5, round(rnd.gauss(quality, 0.8))))
            start = datetime.fromisoformat(f"{s['Date']}T{s['End'] or s['Start']}") + timedelta(minutes=rnd.randint(-10, 90))
            rows.append(to_row({"session": {"id": s["ID"], "title": s["Title"], "speakers": s["Speakers"], "room": s["Room"],
                                            "date": s["Date"], "start": s["Start"], "end": s["End"], "track": s["Track"]},
                                "answers": {"Overall (1-5)": o, "Speakers (1-5)": max(1, min(5, o + rnd.choice([-1, 0, 0, 1]))),
                                            "Relevance (1-5)": rnd.choice(["", max(1, min(5, o + rnd.choice([-1, 0, 1])))]),
                                            "Will apply": rnd.choices(["Yes, definitely", "Maybe", "No", ""], [o, 2, 0.5, 1])[0],
                                            "Key takeaway": rnd.choice(take), "Suggestions": rnd.choice(better),
                                            "Came from": rnd.choices(["QR code", "Link", "Home screen"], [7, 2, 1])[0]}},
                               start.isoformat()))
    for t in ["Evening keynote", "the one about legacies in the big room", "Matt Derby session"]:
        rows.append(to_row({"session": {"id": "NOT LISTED", "title": t}, "answers": {"Overall (1-5)": 4, "Came from": "QR code"}},
                           "2026-10-22T12:00:00"))
    return rows


FAKE = fake_rows(int(os.environ.get("MOCK_FAKE", "0"))) if os.environ.get("MOCK_FAKE") else []


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/config.js":  # same config, pointed at this mock
            # whatever the real address is, point the form at this mock instead
            text = re.sub(r"apiUrl:\s*'[^']*'", f"apiUrl: 'http://localhost:{PORT}/exec'", (ROOT / "config.js").read_text())
            body = text.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif u.path == "/sessions-ifc2026.csv":   # the "website copy" matches the mock's own list
            body = (ROOT / os.environ.get("MOCK_SESSIONS", "sample-data/sessions-sample.csv")).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif u.path == "/exec":
            if state["fail"]:
                return self.send_json({"ok": False}, 503)
            self.send_json({"ok": True, "sessions": load_sessions()})
        elif u.path == "/_received":
            self.send_json(received)
        else:
            super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        if u.path == "/_fail":
            state["fail"] = parse_qs(u.query).get("on", ["1"])[0] == "1"
            return self.send_json({"fail": state["fail"]})
        if u.path == "/_busy":                          # next N sends get a "busy" error reply
            state["busy"] = int(parse_qs(u.query).get("n", ["1"])[0])
            return self.send_json({"busy": state["busy"]})
        if u.path == "/_events":
            return self.send_json(events)
        if u.path == "/exec":
            if state["fail"]:
                self.connection.close()  # like losing signal mid-request
                return
            item = json.loads(body)
            if item.get("action") == "dashboard":
                if item.get("key") != DASH_KEY:
                    return self.send_json({"ok": False, "error": "wrong password"})
                rows = FAKE + [to_row(r) for r in received if bool(r.get("test")) == bool(item.get("test"))]
                rows = [dict(r, _row=i + 2) for i, r in enumerate(rows)]
                for i, r in enumerate(rows):
                    if r["_row"] in assigned:
                        s = assigned[r["_row"]]
                        r.update({"Session ID": s["ID"], "Session": s["Title"], "Room": s["Room"], "Date": s["Date"],
                                  "Note": f'Typed in as "{r["Session"]}", matched on dashboard'})
                ev = {}
                for e in events:
                    if bool(e.get("test")) == bool(item.get("test")):
                        ev[e["type"]] = ev.get(e["type"], 0) + 1
                return self.send_json({"ok": True, "generated": "now", "sessions": load_sessions(), "responses": rows,
                                       "events": ev, "health": {"automatic": True, "waiting": 0, "lastProcessed": None}})
            if item.get("action") == "assign":
                if item.get("key") != DASH_KEY:
                    return self.send_json({"ok": False, "error": "wrong password"})
                s = next((x for x in load_sessions() if x["ID"] == item.get("sessionId")), None)
                if not s:
                    return self.send_json({"ok": False, "error": "session not found"})
                assigned[item["row"]] = s
                return self.send_json({"ok": True})
            if item.get("action") == "event":
                events.append(item)
                return self.send_json({"ok": True})
            if state.get("busy"):                       # Google answering "busy" (not a dropped connection)
                state["busy"] -= 1
                return self.send_json({"ok": False, "error": "Exception: Service invoked too many times"})
            if any(r["rid"] == item["rid"] for r in received):
                return self.send_json({"ok": True, "duplicate": True})
            received.append(item)
            return self.send_json({"ok": True})
        self.send_json({"ok": False}, 404)


if __name__ == "__main__":
    print(f"Serving on http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
