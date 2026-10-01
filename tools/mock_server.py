#!/usr/bin/env python3
"""
Local test server: serves the form and pretends to be the Google Apps Script
backend, so you can test end to end without touching the real Sheet.

    python3 tools/mock_server.py            # then open http://localhost:8765

/exec?action=sessions   returns the sample CSV as JSON, like the real backend
POST /exec              stores the response in memory; GET /_received lists them
POST /_fail?on=1        makes /exec fail (simulates no signal); ?on=0 to recover
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
received, state = [], {"fail": False}


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
        elif u.path == "/exec":
            if state["fail"]:
                return self.send_json({"ok": False}, 503)
            with (ROOT / os.environ.get("MOCK_SESSIONS", "sample-data/sessions-sample.csv")).open(encoding="utf-8") as f:
                self.send_json({"ok": True, "sessions": list(csv.DictReader(f))})
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
        if u.path == "/exec":
            if state["fail"]:
                self.connection.close()  # like losing signal mid-request
                return
            item = json.loads(body)
            if any(r["rid"] == item["rid"] for r in received):
                return self.send_json({"ok": True, "duplicate": True})
            received.append(item)
            return self.send_json({"ok": True})
        self.send_json({"ok": False}, 404)


if __name__ == "__main__":
    print(f"Serving on http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
