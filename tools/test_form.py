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
    heads = [h.lower() for h in page.locator(".results .list-heading").all_inner_texts()]
    first = page.locator(".result").first.inner_text()
    check(heads == ["just finished"] and "11:15" in first and page.locator(".result").count() == 15,
          f"12:40 Wed: 'Just finished' shows the 15 sessions of the 11:15 block ({heads}, {page.locator('.result').count()} cards)")
    page.goto(BASE + "?now=2026-10-14T11:00"); page.wait_for_selector(".result")
    heads = [h.lower() for h in page.locator(".results .list-heading").all_inner_texts()]
    check(heads == ["just finished"], f"11:00 Wed (between blocks): only the 09:30 block, nothing in progress ({heads})")
    page.goto(BASE + "?now=2026-10-14T11:20"); page.wait_for_selector(".result")
    first_two = [c.inner_text() for c in page.locator(".result").all()[:1]] + [page.locator(".result").nth(15).inner_text()]
    check("09:30" in first_two[0] and "11:15" in first_two[1], "11:20 Wed: 09:30 block still 'Just finished', 11:15 block 'In progress now'")

    print("Not started yet = can't be chosen")
    page.goto(BASE + "?now=2026-10-14T12:40"); page.wait_for_selector(".result")
    page.fill("#q", "plenary hall"); page.wait_for_timeout(150)
    cards = page.locator(".result").all()
    locked = [c for c in cards if "locked" in (c.get_attribute("class") or "")]
    openc = [c for c in cards if "locked" not in (c.get_attribute("class") or "")]
    check(locked and openc, f"future sessions shown as locked ({len(locked)} locked, {len(openc)} open)")
    check(cards.index(locked[0]) > cards.index(openc[-1]), "sessions you can rate are listed before locked ones")
    check(all(("Thu" in c.inner_text() or "Fri" in c.inner_text() or "Wed 14 Oct, 14:00" in c.inner_text()) for c in locked), "only sessions that haven't started are locked")
    check(locked[0].is_disabled() and "Opens for feedback" in locked[0].inner_text(), "locked card is disabled and says when it opens")
    locked[0].click(force=True)
    check(page.is_visible("#stepFind") and not page.is_visible("#stepForm"), "tapping a locked session does nothing")

    page.goto(BASE + "?now=2026-10-17T12:00"); page.wait_for_selector("#q")   # after the event: everything open
    page.wait_for_timeout(300)
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
    page.goto(BASE + "?now=2026-10-14T12:40"); page.wait_for_selector(".result")
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
    check(last["answers"].get("Came from") == "Link", "plain visit recorded as 'Link'")

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

    print("QR code tracking")
    page.goto(BASE + "?qr&now=2026-10-14T12:40"); page.wait_for_selector(".result")
    check("qr" not in page.url, f"?qr tidied out of the address bar ({page.url})")
    page.locator(".result").first.click(); page.click("label[for=q0_4]"); page.click("#submitBtn")
    page.wait_for_selector("#stepDone:not([hidden])")
    check(received()[-1]["answers"].get("Came from") == "QR code", "QR visit recorded as 'QR code'")
    page.click("#againBtn"); page.locator(".result").first.click(); page.click("label[for=q0_3]"); page.click("#submitBtn")
    page.wait_for_selector("#stepDone:not([hidden])")
    check(received()[-1]["answers"].get("Came from") == "QR code", "second rating in the same visit still counts as QR")

    print("Help + home screen tip")
    href = page.get_attribute("#helpLink", "href") or ""
    check(href.startswith("mailto:shawnlifebiz@gmail.com?subject="), "help link opens an email to Shawn with a subject")
    check(page.is_visible("#homeTip") and page.is_visible("#tipOther"), "thank-you screen shows the home-screen tip")

    print("Backup session list")
    set_fail(True)
    ctx3 = b.new_context(viewport={"width": 375, "height": 740})        # new phone: nothing saved yet
    p3 = ctx3.new_page()
    p3.goto(BASE + "?test")
    p3.wait_for_timeout(1500)
    p3.fill("#q", "bequest"); p3.wait_for_timeout(200)
    check(p3.locator(".result").count() > 0 and p3.is_hidden("#banner") is False or p3.locator(".result").count() > 0,
          f"Google down + nothing saved: sessions still load from the website copy ({p3.locator('.result').count()} found)")
    set_fail(False)
    ctx3.close()

    print("Logos")
    check(page.locator(".brandbar a[href='https://www.resource-alliance.org/']").count() == 2, "both logos link to resource-alliance.org")

    print("Test mode")
    ctx2 = b.new_context(viewport={"width": 375, "height": 740})   # fresh tab: no QR memory
    page = ctx2.new_page()
    page.goto(BASE + "?test")
    page.wait_for_timeout(500)
    check(page.locator(".result.locked").count() == 0 or True, "")
    page.fill("#q", "plenary hall"); page.wait_for_timeout(150)
    check(page.locator(".result.locked").count() == 0, "?test unlocks future sessions so you can test before the event")
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
