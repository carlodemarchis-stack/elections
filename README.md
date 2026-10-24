# US Midterms 2026

Every House seat, Senate race and governorship on the 3 November 2026 ballot, from safest
Democratic to safest Republican, filling in live as civicAPI calls them. Static page, no build:
`index.html` + `data/` snapshots. **Live at https://elections.aguywithascarf.com/** (repo `carlodemarchis-stack/elections`, GitHub Pages from `main`, deployed 2026-10-24).

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
- **Equal blocks** (House only, switch beside the map; `?view=blocks` opens it): one identical square per
  district. Each state is a block five squares tall (filled top to bottom, then left to right, safest D
  first) with its code and seat count above; the blocks flow in a sequence from the biggest state to the
  smallest and wrap onto rows, so it needs no sideways scroll at any width. The choice is kept in localStorage.
- Detail panel, hover tooltip, and a full table (the non-colour view).
- `help/` is the guide page (linked from the top bar): today's numbers pulled live, plus a walkthrough of what
  changes when votes are counted. If the results-mode behaviour in `index.html` changes, update it too.
- From 3 Nov 10:00 UTC the page polls results every 60 s: called seats go solid party colour,
  uncalled ones fade, a white cap marks a call against the forecast's lean.

## How fresh data gets to the page

```
civicAPI  <--  elections-cache (Supabase edge function)  <--  every browser
                 |-- public.elections_cache (one row per feed: last payload + refresh lock)
```

- **Page:** forecast on load and every 10 min; results on load, then every 60 s once it is election
  day (from 3 Nov 10:00 UTC, 5 am Eastern), only while the tab is visible and again the moment you
  return to it. A tab opened before election day flips into results mode by itself.
- **Cache** (`supabase/functions/elections-cache`, project `atgelibbknccvxtuolay`, public, no JWT):
  results live 30 s, forecast 10 min. One conditional UPDATE is the lock, so of any number of
  simultaneous requests exactly one refreshes from civicAPI and the rest are served the stored copy
  at once (`X-Cache: hit | miss | stale | direct`). Tested: 30 parallel requests at expiry gave 1
  refresh and 29 `stale`. If civicAPI is down, the last good copy is served.
- **Why a table:** Supabase starts a fresh instance for most requests, so an in-memory cache
  measured 1 hit in 22. Do not go back to one. Its CDN does not cache function responses either.
- **Fallbacks, in order:** the cache, then civicAPI directly, then the snapshots in `data/`.
  `?cache=off` skips the cache, handy for comparing.
- **Worst-case lag** from civicAPI publishing to your screen: 30 s cache + 60 s poll, about 90 s.
- **The table** is `public.elections_cache`: RLS on, no policies, no grants to anon or
  authenticated (checked), so only the function's service role can touch it. Migration in
  `supabase/migrations/`. The function holds the service-role key; nothing from a request is ever
  put into an upstream URL.
- **Quota:** one function call per viewer per minute while live. Watch the Supabase function
  invocation count on the night; the free tier is 500k a month.
- Redeploy the function with the Supabase MCP `deploy_edge_function` (`verify_jwt: false`) using
  `supabase/functions/elections-cache/index.ts` as the file.

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

## Deployed (2026-10-24)

Repo `carlodemarchis-stack/elections`, Pages from `main`, custom domain via the `CNAME` file,
HTTPS enforced. The hub (`dataviz/`) carries the v1.0.0 release entry, a quick link and a
workshop card; the version badge on the page fills from it. OG tags + `img/og.png` (a real
1200x630 screenshot of the House view; bump `?v=` when it changes), Umami block with the
`?noumami` opt-out (site "Midterms 2026", id in `umami-tools/website_ids.json`).

Still to do:

1. Check the real feed once on a day that has results, not only `?demo`. Measure how often civicAPI
   actually publishes new counts; the cache and poll intervals assume about a minute.
2. Run the URL through LinkedIn Post Inspector to force the preview scrape.
3. Optional layers: FEC money-vs-votes, Polymarket/Kalshi odds line. Re-capture `og.png` on the
   night if the page looks better filled in.
