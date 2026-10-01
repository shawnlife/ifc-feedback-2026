# IFC 2026 Session Feedback: one-time setup

About 20 minutes. You do this once, before the event. After that, the only thing anyone touches is the **Sessions** tab in the Google Sheet.

## How it fits together

```
Attendee's phone  --->  the form (static web page, GitHub Pages)
                            |  reads the session list
                            |  sends each response
                            v
                   Google Apps Script web app  <--->  one Google Sheet
                                                       Sessions | Responses | Test responses | Summary
```

There is no server to look after and nothing to pay for.

## Step 1: Make the Google Sheet

1. Create a new Google Sheet. Name it **IFC 2026 Session Feedback**.
2. **Extensions > Apps Script**. Delete what is in the editor, paste the whole of `backend/apps_script.js`, click **Save**.
3. Go back to the Sheet and reload the page. A new menu called **IFC Feedback** appears.
4. **IFC Feedback > First-time setup**. Google asks for permission the first time: click through (Advanced > Go to project, if it warns you; it's your own script). This creates the four tabs.

## Step 2: Put the programme in

1. Click the **Sessions** tab. Row 1 must have these headings (order does not matter, extra columns are ignored):

   | ID | Title | Speakers | Organisations | Room | Date | Start | End | Track |
   |---|---|---|---|---|---|---|---|---|

   - **ID** is optional. If the programme export has session codes, use them. If you leave it blank, one is made automatically.
   - **Date** like `2026-10-14` or `14/10/2026`. **Start / End** like `14:00`.
   - If the export has one column like `09:30 - 10:45` called **Time**, that works too.
2. Easiest way: **File > Import > Upload** the CSV, and choose **Replace current sheet** while the Sessions tab is selected.
3. **IFC Feedback > Check the session list for problems**. Fix anything it lists.

**The real programme is already prepared:** import `sessions-ifc2026.csv` (126 sessions pulled from the Cvent schedule, with rooms, session codes, speakers, organisations and tracks). Meals, breaks, yoga, drinks and the "Workshop TBC" placeholders are left out.

If the Cvent programme changes before the event, run `python3 tools/fetch_cvent.py` to rebuild the file, then import it again. During the event, just edit the Sheet directly.

## Step 3: Publish the backend

1. In the Apps Script editor: **Deploy > New deployment**. Click the gear, choose **Web app**.
2. **Execute as: Me**. **Who has access: Anyone** (not "Anyone with a Google account", or attendees would have to log in).
3. **Deploy**. Copy the **Web app URL** (ends in `/exec`).
4. Paste it into `config.js` between the quotes on the `apiUrl:` line.

**If you ever change the script later:** Deploy > **Manage deployments** > pencil icon > Version: **New version** > Deploy. Do NOT make a "New deployment", that gives a new URL and the form would stop saving.

## Step 4: Test before the event

Open the form with `?test` on the end, for example `https://feedback.example.com/?test`. An orange banner says "Test mode" and every response goes to the **Test responses** tab, not the real results. Submit a few, check they appear.

To see the "just finished" list as it will look on the day, add a pretend time: `?test&now=2026-10-14T12:40`.

## Step 5: The QR code

Once the address is final:

```
python3 tools/make_qr.py https://your-final-address/
```

This makes `qr/feedback-qr.png` (for slides), `qr/feedback-qr.svg` (for print) and an A5 room sign. Scan the printed one with two different phones before printing 150 copies.

## Changing the questions or colours

- Questions: `config.js`. Each question's `column` is the heading it gets in the Sheet.
- Colours: the first lines of `style.css`, marked BRAND COLOURS.

## Privacy (GDPR)

The form stores no names, emails, IP addresses or cookies. The phone keeps two small notes in its own storage: which sessions it has already rated (to show a tick), and any response that could not be sent yet (so a wifi drop never loses it). Neither leaves the phone except as the response itself. Free-text answers could contain a name if someone types one, so treat the Responses tab as internal.

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css`, `app.js` | The form. No need to edit `app.js`. |
| `config.js` | Backend address, event name, questions. |
| `backend/apps_script.js` | Reference copy of the Google script. |
| `sessions-ifc2026.csv` | The real programme, from Cvent. |
| `tools/fetch_cvent.py` | Rebuilds it from the Cvent schedule page. |
| `sample-data/sessions-sample.csv` | 150 made-up sessions, used by the automated tests. |
| `tools/mock_server.py`, `tools/test_form.py` | Local test setup (42 automated checks). |
| `tools/make_qr.py` | QR code and room sign. |
| `ON-THE-DAY-GUIDE.md` | For whoever runs it during the conference. |
