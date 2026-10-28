#!/usr/bin/env python3
"""Refresh the bundled fallback snapshots in ../data from civicAPI (no key needed).

    python3 tools/fetch.py

It will NOT overwrite a good copy with bad data: results flagged test_data (civicAPI runs test
elections) and forecasts whose seat totals or chances of control cannot be right are skipped and the
file already on disk is kept. Six requests, one second apart: the national House / Senate / Governors race
documents (each carries every district or state in `region_results`) and the
three civicAPI forecasts. The page reads the live API first and only falls back
to these files, so this is for offline work and for a sane first paint.
"""
import json, sys, time, urllib.request, urllib.error
from pathlib import Path

BASE = "https://civicapi.org/api/v2"
OUT = Path(__file__).resolve().parent.parent / "data"
RACES = {"house": 87524, "senate": 87528, "gov": 87535}
FORECASTS = {"house": "house", "senate": "senate", "gov": "governor"}
SIZE = {"house": 435, "senate": 100, "gov": 50}
KEEP = ("name", "party", "votes", "percent", "winner", "incumbent", "color", "seats")


def get(path, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(f"{BASE}/{path}", headers={"User-Agent": "agwas-midterms/1.0"})
            return json.load(urllib.request.urlopen(req, timeout=60))
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"  {path}: {e} (try {i + 1}/{tries})", file=sys.stderr)
            time.sleep(3 * (i + 1))
    sys.exit(f"giving up on {path}")


def slim(race):
    """Keep what the page draws; drop the per-candidate ids and flags."""
    race["candidates"] = [{k: c[k] for k in KEEP if k in c} for c in race["candidates"]]
    for r in race["region_results"].values():
        r["candidates"] = [{k: c[k] for k in KEEP if k in c} for c in r["candidates"]]
        r.pop("fill", None)
    return race


for chamber, rid in RACES.items():
    race = get(f"race/{rid}")
    if race.get("test_data"):
        print(f"results-{chamber}: civicAPI is serving TEST data, kept the file already on disk")
        time.sleep(1)
        continue
    race = slim(race)
    (OUT / f"results-{chamber}.json").write_text(json.dumps(race, separators=(",", ":")))
    print(f"results-{chamber}: {len(race['region_results'])} regions, updated {race['last_updated']}")
    time.sleep(1)

for chamber, slug in FORECASTS.items():
    f = get(f"forecast/{slug}/2026/civicapi")
    t, m = f.get("totals") or {}, f.get("monte_carlo") or {}
    total = sum((t.get(k) or 0) for k in ("democrat", "republican", "tossup", "independent"))
    if total != SIZE[chamber] or (m.get("prob_democrat_majority") or 0) + (m.get("prob_republican_majority") or 0) > 100.5:
        print(f"forecast-{chamber}: civicAPI's {f.get('last_updated')} forecast fails sanity checks (totals add up to {total}, chamber is {SIZE[chamber]}), kept the file already on disk")
        time.sleep(1)
        continue
    (OUT / f"forecast-{chamber}.json").write_text(json.dumps(f, separators=(",", ":")))
    print(f"forecast-{chamber}: {len(f['states'])} seats, updated {f['last_updated']}, totals {f['totals']}")
    time.sleep(1)
