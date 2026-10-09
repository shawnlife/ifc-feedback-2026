# IFC 2026 session feedback

The feedback form at **ifc2026survey.com**, its dashboard and the tools behind it.

## What's in this folder

**The website** (published to ifc2026survey.com whenever changes are pushed to GitHub; don't move or rename these):

| Item | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The attendee form |
| `config.js` | Questions, branding, the IFC Online session list |
| `sessions-ifc2026.csv` | The programme (the live copy is the Sessions tab in the Google Sheet) |
| `dashboard/` | The team dashboard (`/dashboard`) |
| `online/` | The IFC Online form (`/online`) |
| `sessionleader/` | The Session Leader form (`/sessionleader`) |
| `tags/` | Page for writing the NFC tags (`/tags`) |
| `allocations/` | Session Leaders pick their top 3 masterclasses (`/allocations`); answers go only to the Sheet |
| `privacy.html` | Privacy notice |
| `assets/` | Logos, banner photo, fonts, app icons |
| `CNAME`, `manifest.webmanifest`, `favicon.ico` | Domain name, home-screen app settings, browser icon |

**Behind the scenes:**

| Folder | What it is |
|---|---|
| `backend/` | The Google Apps Script (pasted into the Sheet) and the Firebase rules |
| `docs/` | Setup guide and reliability notes |
| `tools/` | Scripts for building the session list, QR codes, tests and rehearsals |
| `print/` | QR codes for the posters (on this computer only, not online) |
| `private/` | James's sheet, original logos and photo, the to-get list (on this computer only, never uploaded) |

The on-the-day guide for the team is a shared online page.

Tool made using AI vibe-coding by ShawnLife (shawnlife.com).
