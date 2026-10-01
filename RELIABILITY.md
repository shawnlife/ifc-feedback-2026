# Reliability plan: IFC 2026 session feedback

Goal: no response is ever lost, and the form works for every attendee, every session, all week.
Status as of 1 Oct 2026. ✅ done · 🟡 needs Shawn · ⬜ to do

## 1. What could go wrong, and what catches it

| Risk | Safety net | Status |
|---|---|---|
| Venue wifi or phone signal drops while sending | Answer saved on the phone first, retried every 30 s, on reconnect and on next visit. Never deleted until Google confirms it. | ✅ tested |
| A retry sends the same answer twice | Every response has a unique ID; Google ignores repeats for 6 hours | ✅ tested |
| Google can't be reached when the page opens | Session list comes from (1) copy saved on the phone, (2) the copy published with the website (shown first, so a crowd opening the form doesn't hit Google at once), then (3) the live Sheet a few seconds later | ✅ tested |
| Google replies "busy" (quota, overload) | Treated as temporary: kept on the phone and retried. (Bug found and fixed 1 Oct: these used to be dropped.) | ✅ tested |
| Someone sorts, edits or deletes rows in Responses | Hidden **Raw log** tab keeps an untouched copy of every response | ✅ built, 🟡 needs script update |
| Spreadsheet deleted or badly damaged | Hourly full copy to a separate Drive folder (48 kept) + Google's own version history | ✅ built, 🟡 needs script update + switch on |
| Too many people submit at the same moment (end of a block) | Load test 1 Oct (old design, 300 sent 40 at once): half refused first time, nothing lost after retries. **Redesigned**: each response is one quick write to the Raw log (no waiting in line), moved to Responses in batches every minute. Phones retry after 3-6 s with random spacing. | 🟡 re-test with 800 after script update |
| Google Apps Script outage for an extended period | Phones keep answers and retry, but only while/when the page is reopened | ⬜ decide on a **second, independent backup endpoint** |
| Someone floods the form with junk | Honeypot field, server checks (ratings 1-5, length limits, no formulas), dashboard can filter by time | ✅ |
| Spreadsheet formula injection ("=HYPERLINK…" typed in a comment) | Neutralised before writing; CSV export neutralised too | ✅ tested |
| Dashboard password guessed | Checked on Google's side, 0.8 s delay per try, locks for 15 min after 20 wrong tries | ✅ built |
| Wrong session list on the day | "Check the session list" menu, "My session isn't listed" fallback, Typed-in panel on the dashboard | ✅ |
| Old phones / Safari / Samsung browser quirks | Plain HTML, no framework. Full test suite passes in Chrome, Safari (WebKit) and Firefox engines | ✅ tested |
| Form found by strangers | noindex everywhere, no links to it, link/QR only | ✅ |
| Session rated before it happened | Locked until start time | ✅ tested |

## Load tests (1 Oct 2026)
| Test | Result | What we did |
|---|---|---|
| 300 sent, 40 at once, original design (lock around everything) | Half refused first time; all but 1 recovered on retry; no loss | Found: slow under load; and phones dropped "busy" replies (bug fixed) |
| 800 sent, 100 at once, lock-free Raw log | All 800 told "saved", **only 114 written**. Google Sheets overwrites rows when written at the same instant | Lock restored around the single write. Decision: **Firebase as the intake** |
| 800 via Firebase | ⬜ after Firebase setup | |

## 2. Tests run so far
- 70 automated checks on the form, in Chrome, Safari and Firefox engines, (search, locking, sending, offline queue, duplicates, back button, QR tracking, backup list, layout at phone width): all pass
- Dashboard: wrong password rejected, all tabs render with 869 made-up responses, no errors
- One real end-to-end response through Google (test mode): saved

## 3. Still to do before the event
1. 🟡 Paste updated script, redeploy (new version), set dashboard password, turn on backups, set Sheet time zone (SETUP.md step 6)
2. 🟡 **Load test 800** after the script update (first test with the old design found the bottleneck, now redesigned)
3. ✅ Browser tests in Safari (WebKit) and Firefox engines: all pass
4. ⏸ **Second backup endpoint** (parked: Shawn unsure; revisit after the 800 load test): a second copy of the script on a *different* Google account; the form switches to it automatically if the main one fails twice in a row
5. ✅ **Privacy notice** at privacy.html (controller: The Resource Alliance, contact@resource-alliance.org as on their own privacy policy). 🟡 Shawn/RA to confirm wording
6. ⬜ Final web address + QR code (decode-checked) + printed sign test with 2 phones
7. ⬜ Event-week checklist: who watches the dashboard, what to do if the "Live" dot turns red, phone numbers

## 4. During the event
- Dashboard "Live" dot red = dashboard can't reach Google. Form keeps saving answers on phones regardless.
- "Last one X min ago" on the Responses tile: during a session block it should never be more than a few minutes.
- Typed-in panel: check twice a day for missing sessions.
