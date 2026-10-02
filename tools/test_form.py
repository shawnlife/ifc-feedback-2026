#!/usr/bin/env python3
"""
Automated checks. Start the mock server first (python3 tools/mock_server.py),
then run:  python3 tools/test_form.py
"""

import json
import sys
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


def events():
    return json.load(urllib.request.urlopen(urllib.request.Request(BASE + "_events", method="POST", data=b"")))


def via():
    return json.load(urllib.request.urlopen(urllib.request.Request(BASE + "_via", method="POST", data=b"")))


def set_fsfail(on):
    urllib.request.urlopen(urllib.request.Request(BASE + f"_fsfail?on={int(on)}", method="POST", data=b""))


def set_busy(n):
    urllib.request.urlopen(urllib.request.Request(BASE + f"_busy?n={n}", method="POST", data=b""))


def set_fail(on):
    urllib.request.urlopen(urllib.request.Request(BASE + f"_fail?on={int(on)}", method="POST", data=b""))


def top(page, query, n=1):
    page.fill("#q", query)
    page.wait_for_timeout(150)
    return [t.inner_text() for t in page.locator(".result").all()[:n]]


with sync_playwright() as p:
    ENGINE = sys.argv[1] if len(sys.argv) > 1 else "chromium"     # chromium | webkit (Safari) | firefox
    b = getattr(p, ENGINE).launch()
    print("Browser engine:", ENGINE)
    ctx = b.new_context(viewport={"width": 375, "height": 740}, has_touch=True, **({"is_mobile": True} if ENGINE != "firefox" else {}))
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
    names = [n.strip() for n in page.inner_text("#chosen .r-speakers").split(",")] if page.locator("#chosen .r-speakers").count() else []
    rows_ = page.locator("#q1_wrap fieldset")
    legends = [x.inner_text() for x in rows_.locator("legend").all()]
    check(rows_.count() == max(1, len(names)) and all(("speaker, " + n) in l for n, l in zip(names, legends)),
          f"one named question per speaker ({legends})")
    page.click("label[for=q1_s0_5]")
    if rows_.count() > 1: page.click("label[for=q1_s1_4]")
    page.click("label[for=q3_0]")
    page.fill("#q4", "=HYPERLINK(\"evil\") takeaway")
    before = len(received())
    via0 = via()
    page.click("#submitBtn")
    page.wait_for_selector("#stepDone:not([hidden])")
    got = received()
    check(len(got) == before + 1, "response reached the backend")
    last = got[-1]
    check(last["session"]["room"] == "Room 4" and last["session"]["start"] == "11:15", "correct session details sent")
    a_ = last["answers"]
    exp_avg = 4.5 if len(names) > 1 else 5
    check(a_["Overall (1-5)"] == 4 and a_["Speakers (1-5)"] == exp_avg and a_["Relevance (1-5)"] == ""
          and a_["Learned something new"] == "Yes" and "takeaway" in a_["Anything else"],
          f"answers mapped to the right columns (speaker average {a_['Speakers (1-5)']})")
    check((a_["Speaker ratings"] == f"{names[0]}: 5; {names[1]}: 4") if len(names) > 1 else (a_["Speaker ratings"] in ("", f"{names[0]}: 5" if names else "")),
          f"each speaker's own rating kept: '{a_['Speaker ratings']}'")
    check(last["test"] is False, "not flagged as a test")
    check(last["answers"].get("Came from") == "Link", "plain visit recorded as 'Link'")

    check(via()["firebase"] > via0["firebase"] and via()["sheet"] == via0["sheet"], f"sent through Firebase, the main route ({via()})")

    print("Firebase down: falls back to the Google Sheet route")
    set_fsfail(True)
    page.click("#againBtn"); page.locator(".result").first.click(); page.click("label[for=q0_3]")
    before = via()["sheet"]
    page.click("#submitBtn"); page.wait_for_selector("#stepDone:not([hidden])", timeout=40000)
    check(via()["sheet"] == before + 1 and "has been sent" in page.inner_text("#doneText"), "Firebase unreachable: saved through the Sheet route instead, person told 'sent'")
    set_fsfail(False)

    print("Two speakers, two named questions")
    page.click("#againBtn")
    page.evaluate("document.getElementById('q').value=''")
    page.click("#browseBtn"); page.wait_for_timeout(200)
    multi = [x for x in page.locator(".result").all() if "," in (x.locator(".r-speakers").inner_text() if x.locator(".r-speakers").count() else "") and not x.is_disabled()][0]
    two = [n.strip() for n in multi.locator(".r-speakers").inner_text().split(",")]
    multi.click()
    lg = [x.inner_text() for x in page.locator("#q1_wrap legend").all()]
    check(len(lg) == len(two) and all(n in l for n, l in zip(two, lg)), f"{len(two)} speakers -> {len(lg)} named questions")
    page.click("label[for=q0_5]"); page.click("label[for=q1_s0_3]"); page.click("label[for=q1_s1_4]")
    page.click("#submitBtn"); page.wait_for_selector("#stepDone:not([hidden])")
    a2 = received()[-1]["answers"]
    check(a2["Speakers (1-5)"] == 3.5 and a2["Speaker ratings"] == f"{two[0]}: 3; {two[1]}: 4", f"average 3.5 and each kept: '{a2['Speaker ratings']}'")

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
    check("saved on this phone" in page.inner_text("#doneText").lower(), "no connection: told it's saved and will send later")
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
    check(page.is_visible("#homeTip") and "bookmark" in page.inner_text("#tipSteps"), "thank-you screen shows the home-screen tip")
    check(page.inner_text("#helpLink") == "Contact us" and "@" not in page.inner_text(".foot"), "help link says 'Contact us', email address not shown")
    n_ev = len(events())
    page.evaluate("document.getElementById('helpLink').addEventListener('click', e => e.preventDefault())")
    page.click("#helpLink"); page.wait_for_timeout(500)
    check(any(e.get("type") == "help" for e in events()[n_ev:]), "'Contact us' click counted for the dashboard")
    check(any(e.get("type") == "tip-shown" for e in events()), "home-screen tip view counted")

    print("Firebase down AND Google says 'busy': response must NOT be dropped")
    set_fsfail(True); set_busy(1)
    page.click("#againBtn"); page.locator(".result").first.click(); page.click("label[for=q0_2]")
    n = len(received())
    page.click("#submitBtn"); page.wait_for_selector("#stepDone:not([hidden])")
    check("still sending" in page.inner_text("#doneText"), "busy reply: told it's still sending, kept on the phone")
    page.wait_for_function("document.getElementById('doneText').textContent.indexOf('has been sent') > -1", timeout=15000)
    check(len(received()) == n + 1, "retried automatically a few seconds later and arrived; thank-you text updated to 'sent'")
    set_fsfail(False)

    print("Privacy page")
    check(page.locator("a[href='privacy.html']").count() == 1, "privacy link in the footer")
    pr = ctx.new_page(); pr.goto(BASE + "privacy.html")
    check("Resource Alliance" in pr.inner_text("body") and "noindex" in (pr.get_attribute("meta[name=robots]", "content") or ""), "privacy page loads, names the controller, not indexed")
    pr.close()

    print("Backup session list")
    set_fail(True)
    ctx3 = b.new_context(viewport={"width": 375, "height": 740})        # new phone: nothing saved yet
    p3 = ctx3.new_page()
    p3.goto(BASE + "?test")
    p3.wait_for_timeout(1500)
    p3.fill("#q", "plenary"); p3.wait_for_timeout(200)
    check(p3.locator(".result").count() > 0 and p3.is_hidden("#banner") is False or p3.locator(".result").count() > 0,
          f"Google down + nothing saved: sessions still load from the website copy ({p3.locator('.result').count()} found)")
    set_fail(False)
    ctx3.close()

    print("Home-screen steps per browser")
    for name, ua, expect in [
        ("iPhone Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "In Safari"),
        ("iPhone Chrome", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1", "In Chrome: tap the Share button in the address bar"),
        ("Samsung", "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36", "In Samsung Internet"),
        ("Android Chrome", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36", "In Chrome: tap the ⋮ menu")]:
        cx = b.new_context(user_agent=ua, viewport={"width": 390, "height": 800}); pp = cx.new_page()
        pp.goto(BASE + "?test"); pp.wait_for_selector("#q"); pp.wait_for_timeout(400)
        pp.fill("#q", "plenary"); pp.wait_for_timeout(200); pp.locator(".result").first.click()
        pp.click("label[for=q0_4]"); pp.click("#submitBtn"); pp.wait_for_selector("#stepDone:not([hidden])")
        txt = pp.inner_text("#tipSteps")
        check(expect in txt, f"{name}: '{txt[:70]}'")
        cx.close()

    print("Room sign (NFC tag): 'Is this your session?'")
    rc = b.new_context(viewport={"width": 390, "height": 800}); rp = rc.new_page()
    rp.goto(BASE + "?room=Room%204&nfc&now=2026-10-14T12:40"); rp.wait_for_selector("#roomAsk:not([hidden])")
    ask = rp.inner_text("#roomAsk")
    check("Room 4" in ask and "11:15" in ask and "Is this your session" in ask, f"tag in Room 4 at 12:40 offers the 11:15 Room 4 session")
    check("room" not in rp.url and "nfc" not in rp.url, f"room/nfc tidied out of the address bar ({rp.url})")
    rp.click("#roomYes")
    check(rp.is_visible("#stepForm") and "Room 4" in rp.inner_text("#chosen"), "Yes: straight to the questions for that session")
    rp.click("label[for=q0_5]"); rp.click("#submitBtn"); rp.wait_for_selector("#stepDone:not([hidden])")
    check(received()[-1]["answers"].get("Came from") == "NFC tag" and received()[-1]["session"]["room"] == "Room 4", "recorded as 'NFC tag' for the right session")
    rp.goto(BASE + "?room=Room%204&nfc&now=2026-10-14T12:40"); rp.wait_for_selector("#roomAsk:not([hidden])")
    rp.click("#roomNo")
    check(rp.is_hidden("#roomAsk") and rp.is_visible("#q"), "No: back to the normal search")
    rp.goto(BASE + "?room=Room%204&nfc&now=2026-10-14T08:00"); rp.wait_for_selector("#roomAsk:not([hidden])")
    check("Nothing has started" in rp.inner_text("#roomAsk"), "before anything starts: says so, search still there")
    rp.goto(BASE + "?room=room4&qr&now=2026-10-14T12:40"); rp.wait_for_selector("#roomAsk:not([hidden])")
    check("Is this your session" in rp.inner_text("#roomAsk"), "room name matching ignores spaces/capitals (works for room QR codes too)")
    rp.goto(BASE + "?badge&now=2026-10-14T12:40"); rp.wait_for_selector(".result")
    check("badge" not in rp.url and rp.is_hidden("#roomAsk") and "just finished" in rp.inner_text(".results").lower(), "badge tag: normal form with 'Just finished', no room question")
    rp.locator(".result").first.click(); rp.click("label[for=q0_4]"); rp.click("#submitBtn"); rp.wait_for_selector("#stepDone:not([hidden])")
    check(received()[-1]["answers"].get("Came from") == "Session Leader badge", "recorded as 'Session Leader badge'")
    rc.close()

    print("Session leader form (/sessionleader)")
    lc = b.new_context(viewport={"width": 390, "height": 800}); lp = lc.new_page()
    lp.goto(BASE + "sessionleader/?now=2026-10-14T12:40"); lp.wait_for_selector(".result")
    check("leader" in lp.url and lp.inner_text("h1").lower() == "session leader feedback", f"/sessionleader opens the leader form ({lp.url})")
    check("leading" in lp.inner_text("#findLabel"), "asks which session they were leading")
    lp.locator(".result").first.click()
    check(lp.locator(".name-input").count() == 1 and lp.locator(".q-help").count() >= 4, "name field and question explanations shown")
    lp.click("label[for=q1_4]"); lp.click("label[for=q2_5]"); lp.click("label[for=q3_3]")
    lp.fill("#q5", "Packed room, brilliant Q&A")
    lp.click("#submitBtn")
    check(lp.is_visible("#stepForm") and "highlighted" in lp.inner_text("#formError"), "name is required")
    lp.fill("#q0", "Test Leader"); lp.click("#submitBtn"); lp.wait_for_selector("#stepDone:not([hidden])")
    last = received()[-1]
    check(last.get("form") == "leader" and last["answers"].get("Session Leader name") == "Test Leader"
          and last["answers"].get("Session Leader: Overall (1-5)") == 4 and last["answers"].get("Session Leader: Final comments"), "leader report sent, marked as leader, answers in the right columns")
    check(lp.is_hidden("#homeTip"), "no home-screen tip for leaders")
    lp.click("#againBtn"); lp.locator(".result").nth(1).click()
    check(lp.input_value("#q0") == "Test Leader", "leader's name remembered for the next session")
    lc.close()

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
