#!/usr/bin/env python3
"""Freeze what is predicted right now as the pre-election baseline, to be compared with the results.

    python3 tools/freeze_baseline.py            # refuses if a baseline already exists
    python3 tools/freeze_baseline.py --force    # replaces it

Copies, byte for byte, into archive/baseline/:
    forecast-house|senate|gov.json   the civicAPI forecasts the page is serving (data/)
    sources.json                     Kalshi and Fox News, every race: [rating, democrat_pct|null]
    forecast-<stamp>.json            the archived civicAPI snapshots the scorecard builds its prediction from
    sources-<stamp>.json             the archived Kalshi / Fox snapshot
    MANIFEST.json                    when it was frozen, each file's sha256 and the date its source says

Nothing here is read by a page; it is a record that no later refresh can overwrite. Standard library only.
"""
import hashlib, json, shutil, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "archive" / "baseline"


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def last(index):
    return json.loads((ROOT / "archive" / index).read_text())["snapshots"][-1]


def main():
    if OUT.exists() and "--force" not in sys.argv:
        sys.exit(f"{OUT.relative_to(ROOT)} already exists; --force to replace it")
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)

    files, dates = {}, {}
    for k in ("house", "senate", "gov"):
        src = ROOT / "data" / f"forecast-{k}.json"
        shutil.copy2(src, OUT / src.name)
        files[src.name] = sha(src)
        dates[src.name] = json.loads(src.read_text()).get("last_updated")
    src = ROOT / "data" / "sources.json"
    shutil.copy2(src, OUT / src.name)
    files[src.name] = sha(src)
    dates[src.name] = {a: {c: v["last_updated"] for c, v in d.items()} for a, d in json.loads(src.read_text()).items()}

    # every archived civicAPI snapshot: the scorecard may mix the newest ratings with older odds
    for sn in json.loads((ROOT / "archive" / "forecast" / "index.json").read_text())["snapshots"]:
        src = ROOT / "archive" / "forecast" / sn["file"]
        dst = OUT / f"forecast-{sn['file']}"
        shutil.copy2(src, dst)
        files[dst.name] = sha(dst)
        dates[dst.name] = {"observed": sn["observed"], "civicapi_date": sn["updated"], "problems": sn.get("problems")}
    snaps = json.loads((ROOT / "archive" / "forecast" / "index.json").read_text())["snapshots"]
    broken = [x for x in snaps if (x.get("problems") or {}).get("senate")]
    sane = [x for x in snaps if not (x.get("problems") or {}).get("senate")]
    sn = sn_src = last("sources/index.json")
    src = ROOT / "archive" / "sources" / sn["file"]
    dst = OUT / f"sources-{sn['file']}"
    shutil.copy2(src, dst)
    files[dst.name] = sha(dst)
    dates[dst.name] = {"observed": sn["observed"], "civicapi_date": sn["updated"]}

    manifest = {
        "frozen": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "what": "pre-election predictions, frozen before any result; compare against archive/results",
        "notes": [
            "Senate: civicAPI published its forecasts of " + ", ".join(sorted({sn["updated"] for sn in broken})) + " broken (seat totals do not add to 100, "
            "both parties 100% control). Their race ratings and percentages are sound and are what the page and scorecard use; the odds "
            "come from the last sane copy (data/forecast-senate.json, " + (sane[-1]["file"] if sane else "none") + ").",
            "Kalshi and Fox News are civicAPI's republished copies (" + ", ".join(f"{k} {v}" for k, v in sn_src["updated"].items()) + "), not live prices. Fox publishes ratings only.",
        ],
        "files": files,
        "dates": dates,
    }
    (OUT / "MANIFEST.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"frozen {len(files)} files at {manifest['frozen']} -> {OUT.relative_to(ROOT)}")


main()
