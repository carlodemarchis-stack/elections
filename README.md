# US Midterms 2026

Every House seat, Senate race and governorship on the 3 November 2026 ballot, from safest
Democratic to safest Republican, filling in live as civicAPI calls them. Static page, no build:
`index.html` + `data/` snapshots. **Live at https://elections.aguywithascarf.com/** (repo `carlodemarchis-stack/elections`, GitHub Pages from `main`, deployed 2026-10-24).

## Run it

```bash
python3 -m http.server 8830     # from this folder; file:// won't work (snapshot fetch)
```

- `?rehearsal` runs the page on civicAPI's own test election (see below); `rehearsal/` is its control page.
- `?replay` steps through the saved test elections (`archive/rehearsal/`) frame by frame with a play button
  and scrubber (arrow keys step); frames are turned back into the shape the live feed has, so every state
  behaves exactly as it does live. Works any time, even when no test election is running.
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

## Saving the prediction, scoring it later

`.github/workflows/archive.yml` runs `tools/archive.py` every hour (every 15 minutes 3-9 Nov) and commits
to `archive/` only when something changed:

- `archive/forecast/<stamp>.json` + `index.json`: the whole forecast (every seat, odds, Monte Carlo
  range), stamped with when WE looked, civicAPI's own date beside it, and a content hash so a quiet
  hour saves nothing. The index also carries each snapshot's chance of control, which is the
  "how the prediction moved" table.
- `archive/results/<stamp>.json` + `latest.json` + `index.json`: per seat, the called party, reporting %
  and the D and R votes, plus the holdover seats.
- **The prediction** = the last forecast saved at or before `LOCK` (3 Nov 10:00 UTC, the same moment the
  page flips to results mode; constant in `scorecard/index.html`). Everything earlier stays in git, so any other
  cut-off can be recomputed.
- `scorecard/` compares it with the results live (through the cache, falling back to the archive's
  `latest.json`): races called the way the forecast favoured, Brier score, calibration by rating, seat
  total against the 90% range, who reached control, the biggest surprises. `?demo=1` scores invented
  outcomes drawn from the forecast's own chances, which is also a check that the maths is calibrated.
- Run it by hand: `python3 tools/archive.py` (or `forecast` / `results`). It needs no key.
- The percentages are read as chances of winning (unconfirmed with civicAPI).

## Three sources: civicAPI, Kalshi, Fox News (added 2026-10-30)

civicAPI's forecast route takes any source in place of `civicapi`:
`/v2/forecast/{house,senate,governor}/2026/{source}`. There are 20 (expert ratings with no percentages:
cook, sabato, foxnews, insideelections, ...; market prices as win %: kalshi, polymarket, predictit). The page uses three:

- **Source cards** under the title say what each one IS (a blend / a prediction market / network ratings) and are
  the switch: `S.fc` is the forecast the page is drawn from, so choosing a source redraws everything. `?source=kalshi`
  or `foxnews` deep-links it and the choice is kept in localStorage. Kalshi has no market on 9 California House
  seats: they are rank 9, "No rating" (hatched), never silently counted as Tossups. Fox has no percentages, so the
  race panel says so instead of drawing a bar, and odds of control exist only on the civicAPI view.
- **Where the three sources disagree**: races two or more steps apart on the shared nine-step scale (the only
  common currency), three lanes per race, ranked by the gap, plus who reads furthest toward each party.
- **Data**: a third cache feed `?k=sources` (Supabase `elections-cache`, 12 fixed URLs now, TTL 10 min, slimmed to
  `{last_updated, states:{CODE:[rating, democrat_pct|null]}}`, about 24 KB), then civicAPI directly, then
  `data/sources.json` (written by `tools/fetch.py`). Row `sources` was added to `public.elections_cache`
  (migration appended). The copies are dated by civicAPI (27 Oct), not live prices.
- Every Senate `totals` field, in every source, carries the +35 holdover bug (see below), so seat counts are always
  added up from the races, never read from `totals`.

## civicAPI test elections, broken forecasts, and the dress rehearsal (found 2026-10-28)

Eight days out, civicAPI started running **test elections**: the race documents carry `test_data: true`,
with invented results, 100% reporting and every race called within about ten hours (25-26 Oct, again
27 Oct). Its 27 Oct **Senate forecast was also published broken** (seat totals added up to 135 in a
100-seat chamber, 100% chance of control for both parties). What that means for the code:

- **`candidates[].seats` on the national documents is a RUNNING total** (holdovers + races called so
  far; Senate D 51 = 34 not up + 17 called). The holdovers are `seats - called wins`. The page, the
  archive and the scorecard all do this now; before the fix the Senate bar would have grown past 100
  seats the moment races were called. Caught by the test data.
- **Test data is never shown as real.** Outside `?rehearsal` the page and scorecard ignore
  `test_data` results and say so; `tools/archive.py` keeps them apart in `archive/rehearsal/` (same
  format, replayable) and `tools/fetch.py` refuses to overwrite good files with them.
- **A forecast that fails sanity checks is not used as published**: chamber totals must add up to 435 / 100 / 50
  and the two chances of control must not exceed 100% together. If its per-race ratings are still sound (the
  right number of races: 435 / 35 / 36), the page, guide and scorecard keep them and rebuild the totals from
  them (seats not up come from the last sane copy), borrowing only the odds and seat range from that copy,
  with a visible note. This is what happens to the 27 Oct Senate forecast (49 D / 5 tossup / 46 R from the
  races; odds D 46.6% / R 28% from 20 Oct). civicAPI's own site does the same for the seat counts but
  still shows the broken 100% / 100% odds. If the races themselves do not add up, the whole last sane copy
  is used. The archive saves the broken one (faithful record) flagged under `problems` (a warning in the
  movement table).
- **`?rehearsal`** runs the page and `scorecard/?rehearsal` against the test election as if it were the
  real night (top bar says so). `rehearsal/` is the control page: is a test election on right now, the
  saved test elections' pace, and one-click links. **On the morning of 3 Nov check that the test flag
  there is OFF**: if civicAPI leaves it on, the live page would ignore the real results.

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
