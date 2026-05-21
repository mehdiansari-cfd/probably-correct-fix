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
  a CSV.
- **Auto-updating data.** The four CSVs are fetched from GitHub at
  runtime and cached in `chrome.storage.local` (6-hour TTL), so
  dataset edits reach installed extensions without a reinstall. A ↻
  refresh button forces an immediate update. The bundled `data/`
  copies are the offline / first-run fallback.

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
└── data/
    ├── waypoints.csv        — ident, country_code
    ├── navaids.csv          — ident, name, type, country_code
    ├── airports.csv         — ident, type, name, iso_country, iata_code, icao_code
    ├── vfr.csv              — ident, name, country_code, airport
    └── countries.json       — { "XX": { name, region, nearby } }
```

## Updating the data

`data/` is the source of truth — edit the CSVs directly and commit
to `main`. There is no build step.

At runtime the four CSVs are fetched from
`raw.githubusercontent.com/<owner>/probably-correct-fix/main/data/`
and cached in `chrome.storage.local` for 6 hours, so a commit reaches
installed extensions on the next popup open — or immediately via the
↻ refresh button. The bundled `data/` copies are the offline /
first-run fallback. `countries.json` is loaded from the bundle only.

## Features

- **Phonetic + fuzzy search** — typing `DAYNI` finds DAYNE; typing
  `DAYNW` (one wrong letter) still finds DAYNE.
- **Nearby-country expansion** — when a country filter is active,
  results also include geographically adjacent countries (with a
  "Nearby" tag and a small score penalty so in-country sorts first).
- **Type filter** — narrow to Waypoints, Navaids, Airports, or VFR.
- **Copy** — one-click copy in uppercase: the ident for waypoints
  and airports, the name for navaids and VFR reporting points.
- **Refresh** — the ↻ button re-fetches the dataset from GitHub on
  demand.
- **Light & dark theme** — toggle in the top-right corner; preference
  is remembered. First-run default follows your OS preference.

## Install

1. Clone or download this repo (and make sure `data/` and the icon
   PNGs are present)
2. Open `chrome://extensions/` and turn on Developer mode
3. Click **Load unpacked** and select this folder
4. Pin the toolbar icon

The extension can also be loaded as a temporary add-on in Firefox via
`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**.

## Permissions

- `storage` — remembers your theme preference and caches the
  dataset CSVs.
- host access to `raw.githubusercontent.com` — used to fetch dataset
  updates. No telemetry.

The CSV files are also shipped inside the extension under `data/`
and used as the offline / first-run fallback.

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
Entry tab, no cloud sync. The dev build (the "Sweden" repo) adds an
Entry tab for adding custom records and Google Sheets sync. The two
builds share search ranking, fact list, and visual design; the
production dataset under `data/` is now maintained directly in this
repo.
