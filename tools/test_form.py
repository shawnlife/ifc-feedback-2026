#!/usr/bin/env python3
"""
Automated checks. Start the mock server first (python3 tools/mock_server.py),
then run:  python3 tools/test_form.py
"""

import json
import urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8765/"
fails = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


def received():
    return json.load(urllib.request.urlopen(BASE + "_received"))


def set_fail(on):
    urllib.request.urlopen(urllib.request.Request(BASE + f"_fail?on={int(on)}", method="POST", data=b""))


def top(page, query, n=1):
    page.fill("#q", query)
    page.wait_for_timeout(150)
    return [t.inner_text() for t in page.locator(".result").all()[:n]]


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 375, "height": 740}, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    print("Search quality")
    page.goto(BASE + "?now=2026-10-14T12:40")
    page.wait_for_selector(".result")
    heading = page.inner_text("#listHeading")
    first = page.locator(".result").first.inner_text()
    check("just finished" in heading.lower() and "11:15" in first, f"empty search shows the 11:15 slot as just finished ({page.locator('.result').count()} cards)")

    cases = [
        ("Room 4", "Room 4"),
        ("room 4 wed", "Room 4"),
        ("Plenary", "Plenary Hall"),
        ("Sofia Nielsen", "Sofia Nielsen"),
        ("nielsn", "Nielsen"),            # typo
        ("tiktok", "TikTok"),
        ("tik tok", "TikTok"),
        ("legasy", "Legacy"),             # typo
        ("seven figure", "seven-figure"),
        ("burnout", "burnout"),
        ("crm", "CRM"),
        ("okafor", "Okafor"),
        ("van dijk", "van Dijk"),
        ("de vries", "de Vries"),
        ("fundraiser burnout", "burnout"),
    ]
    for q, expect in cases:
        r = top(page, q)
        check(r and expect.lower() in r[0].lower(), f"'{q}' -> top result contains '{expect}'" + ("" if r and expect.lower() in r[0].lower() else f"  [got: {r[:1]}]"))

    r = top(page, "room 4 11:15", 1)
    check(r and "Room 4" in r[0] and "11:15" in r[0], "'room 4 11:15' -> Room 4 at 11:15")
    r = top(page, "2pm thursday garden", 1)
    check(r and "Garden Room" in r[0] and "Thu" in r[0] and "14:00" in r[0], "'2pm thursday garden' -> Garden Room Thu 14:00")
    r = top(page, "day 3 atrium", 1)
    check(r and "Atrium" in r[0] and "Thu" in r[0], "'day 3 atrium' -> Atrium on Thursday")
    r = top(page, "zzzzqqq", 1)
    check(not r and "No sessions match" in page.inner_text("#status"), "nonsense query shows a helpful empty message")
    r = top(page, "room 4", 20)
    check(page.locator(".result").count() >= 10, "'room 4' finds all 10 Room 4 sessions")
    check(all("Room 4" in x for x in top(page, "room 4", 10)), "... and the top 10 are all Room 4 (not 4pm or Room 14)")

    print("Browse")
    page.fill("#q", "")
    page.click("#browseBtn")
    check(page.locator("details.slot").count() == 10, "browse shows 10 time slots")
    check(page.locator("details.slot[open]").count() == 1, "the just-finished slot is open by default")

    print("Form + submit")
    page.fill("#q", "room 4 11:15 wed")
    page.wait_for_timeout(150)
    page.locator(".result").first.click()
    check(page.is_visible("#stepForm"), "choosing a session opens the questions")
    page.click("#submitBtn")
    check("highlighted" in page.inner_text("#formError"), "required question blocks sending")
    page.click("label[for=q0_4]")
    check(page.locator(".stars label.on").count() == 4, "4 stars light up")
    page.click("label[for=q1_5]")
    page.click("label[for=q3_0]")
    page.fill("#q4", "=HYPERLINK(\"evil\") takeaway")
    before = len(received())
    page.click("#submitBtn")
    page.wait_for_selector("#stepDone:not([hidden])")
    got = received()
    check(len(got) == before + 1, "response reached the backend")
    last = got[-1]
    check(last["session"]["room"] == "Room 4" and last["session"]["start"] == "11:15", "correct session details sent")
    check(last["answers"]["Overall (1-5)"] == 4 and last["answers"]["Speakers (1-5)"] == 5
          and last["answers"]["Relevance (1-5)"] == "" and last["answers"]["Will apply"] == "Yes, definitely",
          "answers mapped to the right columns")
    check(last["test"] is False, "not flagged as a test")

    print("Back button")
    page.click("#againBtn")
    page.fill("#q", "plenary")
    page.wait_for_timeout(150)
    page.locator(".result").first.click()
    page.go_back()
    check(page.is_visible("#stepFind") and page.url.startswith(BASE), "phone back button returns to the search, stays on the page")
    page.fill("#q", "room 4 11:15 wed")
    page.wait_for_timeout(150)
    check("You rated this" in page.locator(".result").first.inner_text(), "already-rated session is marked")

    print("Offline queue")
    set_fail(True)
    page.fill("#q", "atrium")
    page.wait_for_timeout(150)
    page.locator(".result").first.click()
    page.click("label[for=q0_2]")
    n = len(received())
    page.click("#submitBtn")
    page.wait_for_selector("#stepDone:not([hidden])", timeout=30000)
    check("saved on this phone" in page.inner_text("#doneText"), "no connection: told it's saved and will send later")
    check(len(received()) == n, "nothing arrived while offline")
    set_fail(False)
    page.reload()
    page.wait_for_timeout(1500)
    check(len(received()) == n + 1, "queued response sent automatically on next page load")

    print("Not listed")
    page.click("#manualBtn")
    page.fill("#manualName", "Evening keynote")
    page.click("label[for=q0_5]")
    page.click("#submitBtn")
    page.wait_for_selector("#stepDone:not([hidden])")
    check(received()[-1]["session"]["id"] == "NOT LISTED", "manual entry sent with NOT LISTED marker")

    print("Layout")
    page.goto(BASE)
    page.wait_for_timeout(500)
    ow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
    check(not ow, "no sideways scrolling at 375px")
    check("ShawnLife" in page.inner_text(".foot"), "footer attribution present")

    print("Test mode")
    page.goto(BASE + "?test")
    page.wait_for_timeout(500)
    check("Test mode" in page.inner_text("#banner"), "?test shows the test banner")
    page.fill("#q", "library")
    page.wait_for_timeout(150)
    page.locator(".result").first.click()
    page.click("label[for=q0_3]")
    page.click("#submitBtn")
    page.wait_for_selector("#stepDone:not([hidden])")
    check(received()[-1]["test"] is True, "?test responses are flagged as test")

    check(not errors, "no JavaScript errors" + (": " + "; ".join(errors) if errors else ""))
    b.close()

print("\n" + ("ALL PASSED" if not fails else f"{len(fails)} FAILED"))
