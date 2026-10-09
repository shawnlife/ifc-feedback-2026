#!/usr/bin/env python3
"""
Generate PLACEHOLDER session data so the form can be tested before the real
programme export arrives. Every title and speaker in here is invented.

    python3 tools/make_sample.py

Writes tools/sample-data/sessions-sample.csv (150 sessions, 10 time slots, 4 days).
Replace it with the real export as soon as you have it: same column headings.
"""

import csv
import random
from pathlib import Path

random.seed(2026)
OUT = Path(__file__).parent / "sample-data" / "sessions-sample.csv"

# 10 time slots over 4 days (2 + 3 + 3 + 2), 15 parallel sessions each = 150
SLOTS = [
    ("2026-10-13", "14:00", "15:15"), ("2026-10-13", "15:45", "17:00"),
    ("2026-10-14", "09:30", "10:45"), ("2026-10-14", "11:15", "12:30"), ("2026-10-14", "14:00", "15:15"),
    ("2026-10-15", "09:30", "10:45"), ("2026-10-15", "11:15", "12:30"), ("2026-10-15", "14:00", "15:15"),
    ("2026-10-16", "09:30", "10:45"), ("2026-10-16", "11:15", "12:30"),
]
ROOMS = ["Plenary Hall", "Garden Room", "Atrium", "Library"] + [f"Room {n}" for n in range(1, 12)]
TRACKS = ["Digital", "Major Gifts", "Leadership", "Legacy Giving", "Data & Insight",
          "Storytelling", "Corporate Partnerships", "Community Fundraising",
          "Innovation", "Wellbeing"]
TOPICS = {
    "Digital": ["TikTok fundraising", "email journeys", "AI in donor care", "paid social", "livestream giving"],
    "Major Gifts": ["the seven-figure ask", "donor stewardship", "prospect research", "philanthropy circles"],
    "Leadership": ["leading through change", "board engagement", "building a fundraising culture", "hiring and retention"],
    "Legacy Giving": ["gifts in wills", "legacy messaging", "in-memory giving"],
    "Data & Insight": ["donor retention metrics", "attribution models", "CRM clean-up", "predictive analytics"],
    "Storytelling": ["ethical storytelling", "the power of the case study", "video that converts", "consent-led imagery"],
    "Corporate Partnerships": ["shared-value partnerships", "employee giving", "pitching to CSR teams"],
    "Community Fundraising": ["peer-to-peer events", "challenge events", "local groups", "faith communities"],
    "Innovation": ["test-and-learn culture", "new product development", "regular giving reinvented", "crypto donations"],
    "Wellbeing": ["fundraiser burnout", "psychological safety", "resilience in hard times"],
}
PATTERNS = [
    "Beyond {t}: what actually works", "{T} in practice", "Rethinking {t}",
    "{T}: lessons from the Global South", "Ten things we learned about {t}",
    "{T} for small charities", "The future of {t}", "From zero to scale with {t}",
    "{T}: a masterclass", "Why {t} matters now",
]
FIRST = ["Amara", "Lucas", "Priya", "Sven", "Nomvula", "Mateo", "Aiko", "Fatima", "Jonas", "Chiara",
         "Kwame", "Ingrid", "Rahul", "Sofia", "Tomasz", "Leila", "Pieter", "Grace", "Hiroshi", "Elena",
         "Ade", "Marta", "Daan", "Yasmin", "Olu", "Freya", "Diego", "Anouk", "Sipho", "Maya"]
LAST = ["Okafor", "van Dijk", "Sharma", "Lindqvist", "Dlamini", "Fernandez", "Tanaka", "Haddad",
        "Becker", "Rossi", "Mensah", "Johansson", "Iyer", "Costa", "Nowak", "Nasser", "de Vries",
        "Mwangi", "Sato", "Petrova", "Adeyemi", "Kowalski", "Bakker", "Rahman", "Balogun",
        "Nielsen", "Morales", "Jansen", "Nkosi", "Levi"]


def speaker():
    return f"{random.choice(FIRST)} {random.choice(LAST)}"


rows = []
for s_i, (date, start, end) in enumerate(SLOTS):
    for r_i, room in enumerate(ROOMS):
        track = TRACKS[(s_i + r_i) % len(TRACKS)]
        topic = random.choice(TOPICS[track])
        title = random.choice(PATTERNS).format(t=topic, T=topic[0].upper() + topic[1:])
        n = random.choices([1, 2, 3], weights=[6, 3, 1])[0]
        rows.append({
            "ID": f"S{s_i + 1:02d}-{r_i + 1:02d}",
            "Title": title,
            "Speakers": ", ".join(speaker() for _ in range(n)),
            "Room": room,
            "Date": date,
            "Start": start,
            "End": end,
            "Track": track,
        })

OUT.parent.mkdir(exist_ok=True)
with OUT.open("w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
print(f"Wrote {len(rows)} SAMPLE sessions to {OUT}")
