# "Probably Correct" Fix

**Version 2.0.0** — Toolbar popup for fast aviation lookups.

A clean, search-only popup for finding ICAO waypoints, navaids,
airports, and VFR reporting points. Click the icon, type, hit Copy.

## What's new in 2.0

- **VFR reporting points** as a fourth category.
- **CSV-backed dataset.** The four categories now live in plain CSV
  files under `data/`, with country metadata (name, region, nearby
  countries) split out into `data/countries.json`. The old monolithic
  `waypoints-data.js` is gone — updating the dataset is just editing
  a CSV (or re-running `scripts/build_data.py` from the source data).
- **Async data load.** The popup fetches and parses the four CSVs on
  open with a brief loading state. Total payload is about 1.4 MB.

## Repo layout

```
probably-correct-fix/
├── manifest.json
├── popup.html
├── popup.css
├── popup.js
├── logo.png                 (copy from a prior v1.4.0 build)
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png         (copy from a prior v1.4.0 build)
├── data/
│   ├── waypoints.csv        — ident, country_code
│   ├── navaids.csv          — ident, name, type, country_code
│   ├── airports.csv         — ident, type, name, iso_country, iata_code, icao_code
│   ├── vfr.csv              — ident, name, country_code, airport
│   └── countries.json       — { "XX": { name, region, nearby } }
└── scripts/
    └── build_data.py        — regenerates data/ from the source CSVs
```

## Regenerating the data

The slim CSVs and `countries.json` are derived from the working
"Sweden" repo (the dev tool). Re-run the build whenever the source
data changes:

```powershell
# From the probably-correct-fix repo root
python scripts/build_data.py
# or, with a custom source path:
python scripts/build_data.py --src "C:\path\to\Sweden"
```

The script expects the Sweden repo at `..\Sweden\` (i.e. a sibling
of this folder under `Documents\GitHub\`). It strips lat/lon and
other columns the extension doesn't use, filters airports to those
with an ICAO or IATA code, and recomputes nearby-country lists from
the lat/lon before discarding them.

## Features

- **Phonetic + fuzzy search** — typing `DAYNI` finds DAYNE; typing
  `DAYNW` (one wrong letter) still finds DAYNE.
- **Nearby-country expansion** — when a country filter is active,
  results also include geographically adjacent countries (with a
  "Nearby" tag and a small score penalty so in-country sorts first).
- **Type filter** — narrow to Waypoints, Navaids, Airports, or VFR.
- **Copy** — one-click copy of the identifier in uppercase.
- **Light & dark theme** — toggle in the top-right corner; preference
  is remembered. First-run default follows your OS preference.

## Install

1. Clone or download this repo (and make sure `data/` and the icon
   PNGs are present — see "Regenerating the data" above)
2. Open `chrome://extensions/` and turn on Developer mode
3. Click **Load unpacked** and select this folder
4. Pin the toolbar icon

The extension can also be loaded as a temporary add-on in Firefox via
`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**.

## Permissions

`storage` only — used to remember your theme preference. No host
permissions, no network calls, no telemetry. The CSV files are
shipped inside the extension and loaded from
`chrome-extension://…/data/…`.

## Search ranking

| Tier                          | Example                         | Score |
|-------------------------------|---------------------------------|-------|
| Exact ident / ICAO / IATA     | `EGLL` → EGLL                   | 1000  |
| Name exact match              | `STOCKHOLM` → Stockholm-Arlanda |  950  |
| Prefix match                  | `EGL` → EGLL                    | ~495  |
| Substring match               | `LL` → EGLL                     | 200   |
| Similar-sounding (Soundex)    | `DAYNI` → DAYNE                 |  80   |
| Typo tolerance (≤2 edits)     | `DAYNW` → DAYNE                 |  60   |

Nearby-country results take a –30 penalty.

## Version history

- **v2.0.0** — CSV-backed dataset, VFR reporting points category,
  precomputed country adjacency, lat/lon dropped from on-disk data.
- **v1.4.0** — Production build versioned in lockstep with the dev
  branch. Updated waypoint dataset, light/dark theme, expanded fact
  list.
- Earlier history under previous numbering: v1.5.0 added Safari
  support; v1.3.0 added the dedicated navaid dataset; v1.2.0 added
  phonetic search.

## Relationship to the dev build

This production build is the user-facing version: search only, no
Entry tab, no cloud sync, no host permissions. The dev build (the
"Sweden" repo) adds an Entry tab for adding custom records and
Google Sheets sync. Both builds share the same datasets, search
ranking, fact list, and visual design.
