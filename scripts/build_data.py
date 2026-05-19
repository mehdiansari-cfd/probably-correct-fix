#!/usr/bin/env python3
"""Build the four slim CSVs and countries.json that the extension loads.

Reads the source CSVs from the Sweden/ working repo (the dev tool) and
writes slim CSVs (no lat/lon, only columns the extension uses) plus a
precomputed countries.json with name, region and nearby-country lists.

Usage
    python scripts/build_data.py                       # default paths
    python scripts/build_data.py --src ../Sweden       # custom source

Expects this layout:
    .../GitHub/probably-correct-fix/scripts/build_data.py   <- this file
    .../GitHub/Sweden/{waypoints,navaids,airports,VFR}.csv  <- source

Source schemas (input)
    waypoints.csv:  Country Code, Country Name, Ident, Latitude, Longitude, Procedures
    navaids.csv:    ident, name, type, latitude, longitude, country code, airport, procedures
    airports.csv:   id, ident, type, name, latitude_deg, longitude_deg, elevation_ft, continent,
                    iso_country, iso_region, municipality, scheduled_service, icao_code,
                    iata_code, gps_code, local_code, home_link, wikipedia_link, keywords
    VFR.csv:        ident, name, type, latitude, longitude, country code, airport

Output schemas (in data/)
    waypoints.csv:  ident, country_code
    navaids.csv:    ident, name, type, country_code
    airports.csv:   ident, type, name, iso_country, iata_code, icao_code        (rows with ICAO or IATA only)
    vfr.csv:        ident, name, country_code, airport
    countries.json: { "<cc>": { "name": ..., "region": "AS|EU|...", "nearby": [...] } }
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
NEARBY_PAD_DEG = 3.0      # how much padding to apply when checking bbox overlap
TRIM_PCT = (0.05, 0.95)   # 5th/95th percentile bbox to ignore outlier fixes
TRIM_MIN_N = 10           # only trim if we have this many points to trim

# ICAO continent code → 2-letter region used by the popup region dropdown.
# Antarctica is intentionally excluded — the UI offers AS/AF/EU/OC/SA/NA only.
CONTINENT_REGION = {
    'AS': 'AS', 'EU': 'EU', 'AF': 'AF',
    'OC': 'OC', 'SA': 'SA', 'NA': 'NA',
}

# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------
DMS_RE = re.compile(
    r"""^\s*
        (\d{1,3})       # degrees
        [^\d]+
        (\d{1,2})       # minutes
        [^\d]+
        (\d{1,2}(?:\.\d+)?)   # seconds
        [^\d]*
        ([NSEW])$""",
    re.VERBOSE,
)

def parse_latlon(s):
    """Parse a coordinate that may be decimal degrees or DMS (e.g. '31° 31\\' 13.59 N')."""
    if s is None:
        return None
    s = s.strip()
    if not s:
        return None
    # Decimal first
    try:
        return float(s)
    except ValueError:
        pass
    m = DMS_RE.match(s)
    if not m:
        return None
    d, mn, sec, hemi = m.groups()
    val = float(d) + float(mn) / 60.0 + float(sec) / 3600.0
    if hemi in ('S', 'W'):
        val = -val
    return val

def percentile(arr, p):
    if not arr:
        return None
    a = sorted(arr)
    i = (len(a) - 1) * p
    lo, hi = int(i), -(-int(i + 0.9999999) // 1)  # ceil
    hi = min(hi, len(a) - 1)
    if lo == hi:
        return a[lo]
    return a[lo] + (a[hi] - a[lo]) * (i - lo)

# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------
def add_point(points, cc, lat, lon):
    if not cc or lat is None or lon is None:
        return
    p = points.setdefault(cc, {'lats': [], 'lons': []})
    p['lats'].append(lat)
    p['lons'].append(lon)

def write_csv(path, header, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in rows:
            w.writerow(r)
    return len(rows)

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
def build(src: Path, dst: Path):
    print(f'reading source from: {src}')
    print(f'writing slim data to: {dst}')

    if not src.is_dir():
        sys.exit(f'error: source directory not found: {src}')

    waypoints_in = src / 'waypoints.csv'
    navaids_in   = src / 'navaids.csv'
    airports_in  = src / 'airports.csv'
    vfr_in       = src / 'VFR.csv'

    for p in (waypoints_in, navaids_in, airports_in, vfr_in):
        if not p.is_file():
            sys.exit(f'error: missing source file: {p}')

    country_name = {}                # cc -> canonical name
    country_continent_votes = {}     # cc -> { 'EU': 5, 'AS': 1, ... }
    country_points = {}              # cc -> {'lats': [...], 'lons': [...]}

    # ---- waypoints.csv ----
    rows_out = []
    with waypoints_in.open(encoding='utf-8', newline='') as f:
        r = csv.DictReader(f)
        for row in r:
            ident = (row.get('Ident') or '').strip()
            cc    = (row.get('Country Code') or '').strip()
            name  = (row.get('Country Name') or '').strip()
            if not ident or not cc:
                continue
            if cc and name and cc not in country_name:
                country_name[cc] = name
            lat = parse_latlon(row.get('Latitude'))
            lon = parse_latlon(row.get('Longitude'))
            add_point(country_points, cc, lat, lon)
            rows_out.append([ident, cc])
    n = write_csv(dst / 'waypoints.csv', ['ident', 'country_code'], rows_out)
    print(f'  waypoints.csv:  {n:>6,} rows')

    # ---- navaids.csv ----
    rows_out = []
    with navaids_in.open(encoding='utf-8', newline='') as f:
        r = csv.DictReader(f)
        for row in r:
            ident = (row.get('ident') or '').strip()
            if not ident:
                continue
            name  = (row.get('name') or '').strip()
            typ   = (row.get('type') or '').strip()
            cc    = (row.get('country code') or '').strip()
            lat = parse_latlon(row.get('latitude'))
            lon = parse_latlon(row.get('longitude'))
            add_point(country_points, cc, lat, lon)
            rows_out.append([ident, name, typ, cc])
    n = write_csv(dst / 'navaids.csv', ['ident', 'name', 'type', 'country_code'], rows_out)
    print(f'  navaids.csv:    {n:>6,} rows')

    # ---- airports.csv ----  (filter to rows with ICAO or IATA)
    rows_out = []
    total = 0
    type_counts = {}
    with airports_in.open(encoding='utf-8', newline='') as f:
        r = csv.DictReader(f)
        for row in r:
            total += 1
            icao = (row.get('icao_code') or '').strip()
            iata = (row.get('iata_code') or '').strip()
            if not icao and not iata:
                continue
            ident = (row.get('ident') or '').strip()
            typ   = (row.get('type') or '').strip()
            name  = (row.get('name') or '').strip()
            iso   = (row.get('iso_country') or '').strip()
            cont  = (row.get('continent') or '').strip()
            lat = parse_latlon(row.get('latitude_deg'))
            lon = parse_latlon(row.get('longitude_deg'))
            add_point(country_points, iso, lat, lon)
            if iso and cont in CONTINENT_REGION:
                country_continent_votes.setdefault(iso, {})[cont] = \
                    country_continent_votes.setdefault(iso, {}).get(cont, 0) + 1
            type_counts[typ] = type_counts.get(typ, 0) + 1
            rows_out.append([ident, typ, name, iso, iata, icao])
    n = write_csv(dst / 'airports.csv',
                  ['ident', 'type', 'name', 'iso_country', 'iata_code', 'icao_code'],
                  rows_out)
    print(f'  airports.csv:   {n:>6,} rows (kept of {total:,})')
    if type_counts:
        breakdown = ', '.join(f'{t}={c:,}' for t, c in
                              sorted(type_counts.items(), key=lambda x: -x[1]))
        print(f'                  by type: {breakdown}')

    # ---- vfr.csv ----
    rows_out = []
    with vfr_in.open(encoding='utf-8', newline='') as f:
        r = csv.DictReader(f)
        for row in r:
            ident = (row.get('ident') or '').strip()
            if not ident:
                continue
            name = (row.get('name') or '').strip()
            cc   = (row.get('country code') or '').strip()
            ap   = (row.get('airport') or '').strip()
            lat = parse_latlon(row.get('latitude'))
            lon = parse_latlon(row.get('longitude'))
            add_point(country_points, cc, lat, lon)
            rows_out.append([ident, name, cc, ap])
    n = write_csv(dst / 'vfr.csv', ['ident', 'name', 'country_code', 'airport'], rows_out)
    print(f'  vfr.csv:        {n:>6,} rows')

    # -----------------------------------------------------------------------
    # countries.json — build bboxes, then declare two countries nearby when
    # their boxes overlap with a 3° pad. Skip antimeridian-wrapping countries
    # (Russia, US-Alaska, NZ, etc.) since their boxes are meaningless flat.
    # -----------------------------------------------------------------------
    bbox = {}
    for cc, pts in country_points.items():
        lats = pts['lats']; lons = pts['lons']
        if not lats:
            continue
        if len(lats) >= TRIM_MIN_N:
            min_lat = percentile(lats, TRIM_PCT[0])
            max_lat = percentile(lats, TRIM_PCT[1])
            min_lon = percentile(lons, TRIM_PCT[0])
            max_lon = percentile(lons, TRIM_PCT[1])
        else:
            min_lat, max_lat = min(lats), max(lats)
            min_lon, max_lon = min(lons), max(lons)
        bbox[cc] = (min_lat, max_lat, min_lon, max_lon)

    def wraps(b):
        return (b[3] - b[2]) > 180

    nearby = {}
    keys = list(bbox.keys())
    for i, cc1 in enumerate(keys):
        b1 = bbox[cc1]
        if wraps(b1):
            nearby[cc1] = []
            continue
        out = []
        for j, cc2 in enumerate(keys):
            if i == j:
                continue
            b2 = bbox[cc2]
            if wraps(b2):
                continue
            if (b2[1] >= b1[0] - NEARBY_PAD_DEG and b2[0] <= b1[1] + NEARBY_PAD_DEG and
                b2[3] >= b1[2] - NEARBY_PAD_DEG and b2[2] <= b1[3] + NEARBY_PAD_DEG):
                out.append(cc2)
        nearby[cc1] = sorted(out)

    # Region per country (vote from airports' continent column; fall back blank).
    country_region = {}
    for cc, votes in country_continent_votes.items():
        if votes:
            top = max(votes.items(), key=lambda x: x[1])[0]
            country_region[cc] = CONTINENT_REGION.get(top, '')

    # Final document — every country we ever saw gets an entry.
    all_ccs = set(country_name) | set(country_points) | set(country_region)
    countries_out = {}
    for cc in sorted(all_ccs):
        countries_out[cc] = {
            'name': country_name.get(cc) or cc,
            'region': country_region.get(cc, ''),
            'nearby': nearby.get(cc, []),
        }

    out_path = dst / 'countries.json'
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open('w', encoding='utf-8') as f:
        json.dump(countries_out, f, ensure_ascii=False)
        f.write('\n')

    print(f'  countries.json: {len(countries_out):>6,} entries')
    sample = next(iter(countries_out.values()))
    print(f'                  sample: {sample}')

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    here = Path(__file__).resolve().parent
    default_src = (here / '..' / '..' / 'Sweden').resolve()
    default_dst = (here / '..' / 'data').resolve()

    ap = argparse.ArgumentParser(description='Build the slim extension dataset.')
    ap.add_argument('--src', type=Path, default=default_src,
                    help=f'source dir with the four working CSVs (default: {default_src})')
    ap.add_argument('--dst', type=Path, default=default_dst,
                    help=f'output data dir (default: {default_dst})')
    args = ap.parse_args()

    build(args.src.resolve(), args.dst.resolve())
    print('done.')

if __name__ == '__main__':
    main()
