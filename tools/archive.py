#!/usr/bin/env python3
"""Save civicAPI's forecast and the results as dated snapshots, only when something changed.

    python3 tools/archive.py              # forecast and results
    python3 tools/archive.py forecast     # just the forecast
    python3 tools/archive.py results      # just the results
    python3 tools/archive.py sources      # just Kalshi and Fox News

Run by .github/workflows/archive.yml (hourly, every 15 minutes in election week). Standard
library only. The scorecard page (scorecard/) compares what is saved here.

    archive/forecast/index.json            one line per saved forecast: when, civicAPI's date, the odds
    archive/forecast/<stamp>.json          the whole forecast, every seat, compact
    archive/sources/<stamp>.json           Kalshi and Fox News, every race: [rating, democrat_pct|null]
    archive/sources/index.json             one line per saved copy: when, civicAPI's date for each source
    archive/results/index.json             one line per saved result set: when, how many races called
    archive/results/<stamp>.json           every seat: called party, reporting %, D and R votes
    archive/results/latest.json            a copy of the newest result set (fallback for the page)

A snapshot is written only if its content differs from the previous one, so a quiet hour adds
nothing. Two things civicAPI has done that this guards against (found 2026-10-28):
  - it runs full TEST elections (race documents carry test_data=true, every race "called" within
    hours). Results are NOT saved while that flag is on, so test data never reaches the scorecard.
  - a forecast can be published broken (the 27 Oct Senate one: seat totals added up to 135 in a
    100-seat chamber, and both parties had a 100% chance of control). It is still saved, as a faithful
    record of what was published, but marked under "problems" so the scorecard never uses it. The "observed" time is when WE looked, not when civicAPI published; civicAPI's own date
is kept beside it. Every snapshot stays in git, so any cut-off can be recomputed later.
"""
import hashlib, json, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://civicapi.org/api/v2"
ROOT = Path(__file__).resolve().parent.parent / "archive"
CHAMBERS = {"house": ("house", 87524), "senate": ("senate", 87528), "gov": ("governor", 87535)}
SIZE = {"house": 435, "senate": 100, "gov": 50}   # seats in each chamber, holdovers included


def get(path, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(f"{BASE}/{path}", headers={"User-Agent": "agwas-elections-archive/1.0 (elections.aguywithascarf.com)"})
            return json.load(urllib.request.urlopen(req, timeout=60))
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  {path}: {e} (try {i + 1}/{tries})", file=sys.stderr)
            time.sleep(3 * (i + 1))
    raise SystemExit(f"giving up on {path}")


def party(p):
    p = (p or "").lower()
    return "D" if "democrat" in p else "R" if "republican" in p else "O"


def digest(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]


def stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%MZ"), datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))


def load_index(path):
    return json.loads(path.read_text()) if path.exists() else {"snapshots": []}


# ---------------------------------------------------------------- forecast
def compact_forecast(f):
    seats = {}
    for code, s in f["states"].items():
        seats[code] = [s.get("rating"), s.get("democrat_pct"), s.get("republican_pct"), s.get("independent_pct"),
                       s.get("incumbent_party"), s.get("democratic") or "", s.get("republican") or "", s.get("independent") or ""]
    return {"last_updated": f.get("last_updated"), "totals": f.get("totals"), "monte_carlo": f.get("monte_carlo"),
            "majority_odds": f.get("majority_odds"), "seats": seats}


def forecast_problem(key, c):
    """Why a chamber's forecast cannot be right, or None. Cheap sanity checks only."""
    t, m = c.get("totals") or {}, c.get("monte_carlo") or {}
    total = sum((t.get(k) or 0) for k in ("democrat", "republican", "tossup", "independent"))
    if total != SIZE[key]:
        return f"seat totals add up to {total} in a chamber of {SIZE[key]}"
    if (m.get("prob_democrat_majority") or 0) + (m.get("prob_republican_majority") or 0) > 100.5:
        return "the chances of control add up to more than 100%"
    return None


def archive_forecast():
    chambers = {k: compact_forecast(get(f"forecast/{slug}/2026/civicapi")) for k, (slug, _) in CHAMBERS.items()}
    h = digest(chambers)
    d = ROOT / "forecast"
    idx = load_index(d / "index.json")
    if idx["snapshots"] and idx["snapshots"][-1]["hash"] == h:
        print(f"forecast: unchanged (civicAPI dated {chambers['house']['last_updated']})")
        return False
    name, observed = stamp()
    problems = {k: p for k, c in chambers.items() if (p := forecast_problem(k, c))}
    snap = {"observed": observed, "hash": h, "chambers": chambers}
    if problems:
        snap["problems"] = problems
    write(d / f"{name}.json", snap)
    odds = {k: [c["monte_carlo"].get("prob_democrat_majority"), c["monte_carlo"].get("prob_republican_majority")] for k, c in chambers.items()}
    entry = {"file": f"{name}.json", "observed": observed, "updated": chambers["house"]["last_updated"], "hash": h, "odds": odds}
    if problems:
        entry["problems"] = problems
    idx["snapshots"].append(entry)
    write(d / "index.json", idx)
    print(f"forecast: SAVED {name}.json (civicAPI dated {chambers['house']['last_updated']}, House D {odds['house'][0]}%)")
    for k, why in problems.items():
        print(f"forecast: WARNING {k} looks broken: {why}; saved, but flagged so it is never used")
    return True


# ----------------------------------------------------------------- other sources
# Kalshi (market prices) and Fox News (ratings only) come through the same forecast route as civicAPI's own.
# Prices before election day cannot be recovered later, so they are saved on the same hourly rhythm and the
# scorecard can set them against civicAPI's blend. Same rule: a copy is written only if its content changed.
SOURCES = ("kalshi", "foxnews")


def compact_source(f):
    return {"last_updated": f.get("last_updated"), "has_percentages": f.get("has_percentages"),
            "seats": {k: [s.get("rating"), s.get("democrat_pct")] for k, s in f["states"].items()}}


def archive_sources():
    slug = {"house": "house", "senate": "senate", "gov": "governor"}
    sources = {src: {k: compact_source(get(f"forecast/{slug[k]}/2026/{src}")) for k in CHAMBERS} for src in SOURCES}
    h = digest(sources)
    d = ROOT / "sources"
    idx = load_index(d / "index.json")
    if idx["snapshots"] and idx["snapshots"][-1]["hash"] == h:
        print("sources: unchanged (" + ", ".join(f"{s} dated {sources[s]['house']['last_updated']}" for s in SOURCES) + ")")
        return False
    name, observed = stamp()
    write(d / f"{name}.json", {"observed": observed, "hash": h, "sources": sources})
    idx["snapshots"].append({"file": f"{name}.json", "observed": observed, "hash": h,
                             "updated": {s: sources[s]["house"]["last_updated"] for s in SOURCES}})
    write(d / "index.json", idx)
    print(f"sources: SAVED {name}.json (" + ", ".join(f"{s} {sum(len(c['seats']) for c in sources[s].values())} races" for s in SOURCES) + ")")
    return True


# ----------------------------------------------------------------- results
def compact_race(doc):
    seats = {}
    for key, r in (doc.get("region_results") or {}).items():
        cs = r.get("candidates") or []
        win = next((c for c in cs if c.get("winner")), None)

        def top(p):
            xs = [c for c in cs if party(c.get("party")) == p]
            return max(xs, key=lambda c: c.get("votes") or 0) if xs else None
        d, rp = top("D"), top("R")
        seats[key] = [party(win.get("party")) if win else "", r.get("percent_reporting") or 0,
                      (d or {}).get("votes") or 0, (rp or {}).get("votes") or 0, win.get("name") if win else ""]
    seat_of = lambda name: next((c.get("seats") or 0 for c in doc.get("candidates", []) if c.get("name") == name), 0)
    won = lambda p: sum(1 for s in seats.values() if s[0] == p)
    # civicAPI's national "seats" is a RUNNING total (holdovers + races called so far); the holdovers
    # are what is left after taking the called wins off
    return {"last_updated": doc.get("last_updated"),
            "hold": {"D": max(0, seat_of("Democrats") - won("D")), "R": max(0, seat_of("Republicans") - won("R"))}, "seats": seats}


def archive_results():
    docs = {k: get(f"race/{rid}") for k, (_, rid) in CHAMBERS.items()}
    # civicAPI runs full TEST elections (test_data=true: invented results, every race called within hours).
    # They are kept apart in archive/rehearsal/ (same format) so they can never reach the scorecard,
    # and so a dress rehearsal can still be replayed.
    test = any(d.get("test_data") for d in docs.values())
    chambers = {k: compact_race(d) for k, d in docs.items()}
    called = {k: sum(1 for s in c["seats"].values() if s[0]) for k, c in chambers.items()}
    total = {k: len(c["seats"]) for k, c in chambers.items()}
    # civicAPI's own last_updated moves with every touch; compare the content that matters
    h = digest({k: {"hold": c["hold"], "seats": c["seats"]} for k, c in chambers.items()})
    label = "rehearsal (TEST data)" if test else "results"
    d = ROOT / ("rehearsal" if test else "results")
    idx = load_index(d / "index.json")
    if idx["snapshots"] and idx["snapshots"][-1]["hash"] == h:
        print(f"{label}: unchanged ({called['house']}/{total['house']} House called)")
        return False
    name, observed = stamp()
    snap = {"observed": observed, "hash": h, "chambers": chambers}
    if test:
        snap["test"] = True
    write(d / f"{name}.json", snap)
    write(d / "latest.json", snap)
    entry = {"file": f"{name}.json", "observed": observed, "hash": h, "called": called, "total": total}
    if test:
        entry["test"] = True
    idx["snapshots"].append(entry)
    write(d / "index.json", idx)
    print(f"{label}: SAVED {name}.json (called: " + ", ".join(f"{k} {called[k]}/{total[k]}" for k in called) + ")")
    return True


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("all", "forecast"):
        archive_forecast()
    if what in ("all", "results"):
        archive_results()
    if what in ("all", "sources"):
        archive_sources()
