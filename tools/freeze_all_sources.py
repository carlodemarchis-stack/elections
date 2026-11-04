#!/usr/bin/env python3
"""Freeze every forecast source civicAPI republishes, as it is right now, into archive/baseline/sources-all.json.

    python3 tools/freeze_all_sources.py            # refuses if the file already exists
    python3 tools/freeze_all_sources.py --force

The three-source baseline (freeze_baseline.py) keeps only civicAPI, Kalshi and Fox News. This keeps all of them, for the
"every source" page: {frozen, sources:{id:{name, house|senate|gov:{last_updated, states:{CODE:[rating, democrat_pct|null]}}}}}.
A chamber a source does not cover is simply absent. The list of sources comes from civicAPI's own site code (the API has no
index); an id that returns nothing in all three chambers is kept out. Standard library only.
"""
import json, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "archive" / "baseline" / "sources-all.json"
NAMES = {
    "civicapi": "civicAPI", "afi": "America First Insight", "cme": "CM Election Predictions", "cook": "Cook Political Report",
    "ddhq": "Decision Desk HQ", "electindex": "ElectIndex", "fiftyplusone": "FiftyPlusOne", "foxnews": "Fox News",
    "insideelections": "Inside Elections", "kalshi": "Kalshi", "osz": "OpenSourceZone", "polymarket": "Polymarket",
    "predictit": "PredictIt", "racetothewh": "Race to the WH", "rrh": "RRH Elections", "sabato": "Sabato's Crystal Ball",
    "splitticket": "Split Ticket", "votehub_complete": "VoteHub (Complete)", "votehub_legacy": "VoteHub (Legacy)",
}
CH = {"house": "house", "senate": "senate", "gov": "governor"}


def get(src, slug):
    u = f"https://civicapi.org/api/v2/forecast/{slug}/2026/{src}"
    for n in range(5):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "agwas-freeze/1.0"}), timeout=45))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
        except Exception:
            pass
        time.sleep(2 * (n + 1))
    raise SystemExit(f"{u}: no answer after 5 tries, nothing written")


def main():
    if OUT.exists() and "--force" not in sys.argv:
        sys.exit(f"{OUT.name} already exists; --force to replace it")
    jobs = [(s, k, v) for s in NAMES for k, v in CH.items()]
    with ThreadPoolExecutor(6) as ex:
        docs = list(ex.map(lambda j: get(j[0], j[2]), jobs))
    out = {"frozen": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "sources": {}}
    for (s, k, _), d in zip(jobs, docs):
        st = (d or {}).get("states") or {}
        if not st:
            continue
        e = out["sources"].setdefault(s, {"name": NAMES[s]})
        e[k] = {"last_updated": d.get("last_updated"), "states": {c: [x.get("rating"), x.get("democrat_pct")] for c, x in st.items()}}
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"froze {len(out['sources'])} sources at {out['frozen']} -> {OUT.name} ({OUT.stat().st_size // 1024} KB)")
    for s, e in out["sources"].items():
        print(f"  {s:18}" + " ".join(f"{k}:{len(e[k]['states'])}@{e[k]['last_updated']}" for k in CH if k in e))


main()
