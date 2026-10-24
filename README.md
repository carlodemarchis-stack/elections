# US Midterms 2026

Every House seat, Senate race and governorship on the 3 November 2026 ballot, from safest
Democratic to safest Republican, filling in live as civicAPI calls them. Static page, no build:
`index.html` + `data/` snapshots. **Built, not deployed, not committed.**

## Run it

```bash
python3 -m http.server 8830     # from this folder; file:// won't work (snapshot fetch)
```

- `?demo=0.6` paints an invented election night (60% of races reported) over the real forecast,
  so the election-night states can be seen before there are votes.
- `#house`, `#senate`, `#gov`, `#house/ca-22` deep-link and survive reload.
- `python3 tools/fetch.py` refreshes the fallback snapshots in `data/` (6 requests).

## What is on the page

- Control odds (civicAPI Monte Carlo: `prob_democrat_majority` / `prob_republican_majority`).
- **The band**: one bar per seat, sorted Safe D to Safe R, majority tick (218 / 51 / 26).
  Senate and governors include the seats not up this year as dimmed holdovers.
- **State tiles**: House = one square per district; Senate / governors = one square per state.
- Detail panel, hover tooltip, and a full table (the non-colour view).
- From 3 Nov 10:00 UTC the page polls results every 60 s: called seats go solid party colour,
  uncalled ones fade, a white cap marks a call against the forecast's lean.

## civicAPI, as found (docs page is JS-rendered; routes were read from its bundle)

Base `https://civicapi.org/api/v2`, keyless, CORS `*`. Attribution link required (it is in the top bar).

| Route | Gives |
|---|---|
| `status` | `{"status":"ok"}` |
| `race/87524` / `87528` / `87535` | national House / Senate / Governors: `region_results` has **every** district (435, keys `ca-22`, `ak-al`) or state (35 / 36) with candidates, votes, `percent_reporting`, `winner`. Top-level `candidates[].seats` = holdover seats not up (Senate D34 R31, governors R8 D6). |
| `forecast/{house,senate,governor}/2026/civicapi` | per-seat `rating` (Safe/Likely/Lean/Tilt D/R, Tossup), `democrat_pct`, names, `incumbent_party`; plus `totals`, `monte_carlo`, `majority_odds` |
| `race/search?startDate=&endDate=&country=&query=&limit=` | any race; default limit 20, max 50000. A 5000-row page 503'd once. |
| `getElectionDates?country=US` | dates with race counts |

Forecast keys are upper-case (`CA-22`), results keys lower-case; they match 1:1 for all three chambers.

## Things to confirm

- `democrat_pct` sums to 100 and reads 97-99 for safe seats, so it is treated as **chance of
  winning**, not vote share. Labelled that way in the panel. Not confirmed with civicAPI.
- Senate odds (D 47% / R 28%) leave a quarter unassigned. The grey middle of the bar is labelled
  "neither reaches a majority" (50-50 ties, independents). Inferred.
- Pre-election, `region_results` candidate lists include primary losers with 0 votes; the panel
  only lists candidates once votes exist, and shows the forecast matchup before that.

## Deploy checklist (prepared 2026-10-24, nothing pushed)

Done in the folder: OG/Twitter/canonical + `agwas:*` capture tags (`img/og.png`, a real 1200x630
screenshot of the House view; bump `?v=` when it changes), the Umami block with the `?noumami`
opt-out (site "Midterms 2026", id in `umami-tools/website_ids.json`, created on the Umami server),
the `ver.js` badge + "Release notes" line, `CNAME` (`elections.aguywithascarf.com`), `.nojekyll`.
Done on the hub (`dataviz/`, uncommitted): `releases.json` v1.0.0, a quick link and a workshop card.

Still to do, in this order:

1. Create the GitHub repo, push this folder, enable Pages with the custom domain, add the
   `midterms` DNS record (same as the sibling apps).
2. **Then** push the hub, so the card and the version badge never point at a dead host.
3. Cache proxy for the three `race/` calls (Cloudflare Worker / edge function polling every
   30-60 s); change `API` in `index.html`. Free APIs get hammered on election night.
4. Check the real feed once on a day that has results, not only `?demo`.
5. Optional layers: FEC money-vs-votes, Polymarket/Kalshi odds line. Re-capture `og.png` on the
   night if the page looks better filled in.
