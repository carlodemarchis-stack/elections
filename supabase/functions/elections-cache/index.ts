// elections-cache: one shared cache between the midterms page and civicAPI.
//
//   GET .../elections-cache?k=results   -> {ts, house, senate, gov}  (the 3 national race documents)
//   GET .../elections-cache?k=forecast  -> {ts, house, senate, gov}  (the 3 civicAPI forecasts)
//   GET .../elections-cache?k=sources   -> {ts, kalshi:{house,senate,gov}, foxnews:{...}}  (the same
//                                           forecast route read as two other sources, slimmed to
//                                           {last_updated, states:{CODE:[rating, democrat_pct|null]}})
//
// Without this, every open browser tab asks civicAPI itself every minute. With it, civicAPI sees
// ONE set of three requests per TTL, however many people are watching.
//
// Why a table, not memory: Supabase starts a fresh instance for most requests, so an in-memory
// cache measured 1 hit in 22. The last good payload lives in public.elections_cache instead.
//
//   fresh row            -> serve it                                  (X-Cache: hit)
//   stale row, lock won  -> serve the stored copy now, refresh from civicAPI after the response
//                           (X-Cache: refreshing); with no stored copy it waits and stores (X-Cache: miss)
//   stale row, lock lost -> serve the stale row, someone else is on it (X-Cache: stale)
//
// The lock is one conditional UPDATE (lock_until_ms in the past AND ts_ms older than the TTL),
// which Postgres applies to exactly one of any number of concurrent callers. If civicAPI fails
// the lock simply runs out, so a dead upstream is retried every LOCK_MS, not on every request.
// Each of the documents is refreshed independently: one that fails keeps its previously stored copy.
//
// Safety: only the twelve fixed upstream URLs below are ever fetched (nothing from the request is
// interpolated into one). The service-role key stays inside the function. Public by design
// (verify_jwt = false): it serves only data civicAPI already publishes openly.

const BASE = "https://civicapi.org/api/v2";
const SOURCES = {
  results: {
    ttl: 30_000,
    urls: { house: "race/87524", senate: "race/87528", gov: "race/87535" },
  },
  sources: {
    ttl: 600_000,
    urls: {
      "kalshi:house": "forecast/house/2026/kalshi",
      "kalshi:senate": "forecast/senate/2026/kalshi",
      "kalshi:gov": "forecast/governor/2026/kalshi",
      "foxnews:house": "forecast/house/2026/foxnews",
      "foxnews:senate": "forecast/senate/2026/foxnews",
      "foxnews:gov": "forecast/governor/2026/foxnews",
    },
  },
  forecast: {
    ttl: 600_000,
    urls: {
      house: "forecast/house/2026/civicapi",
      senate: "forecast/senate/2026/civicapi",
      gov: "forecast/governor/2026/civicapi",
    },
  },
} as const;
type Kind = keyof typeof SOURCES;
const FETCH_BUDGET_MS = 45_000;
const LOCK_MS = 60_000; // longer than one refresh can take (FETCH_BUDGET_MS plus the table writes)

const SB = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DB = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};
const TABLE = `${SB}/rest/v1/elections_cache`;

// What the page reads from a result. Dropping the rest (candidate ids and flags, map fills)
// keeps the payload small; the candidate list is cut to the first six by votes, plus any winner.
// deno-lint-ignore no-explicit-any
function slimRace(doc: any) {
  // deno-lint-ignore no-explicit-any
  const keep = (c: any) => ({
    name: c.name, party: c.party, votes: c.votes, percent: c.percent,
    winner: c.winner, incumbent: c.incumbent, color: c.color, seats: c.seats,
  });
  const rr: Record<string, unknown> = {};
  // deno-lint-ignore no-explicit-any
  for (const [k, r] of Object.entries(doc.region_results ?? {}) as [string, any][]) {
    const cs = [...(r.candidates ?? [])].sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0));
    const top = cs.slice(0, 6);
    const win = cs.find((c) => c.winner);
    if (win && !top.includes(win)) top.push(win);
    rr[k] = { name: r.name, percent_reporting: r.percent_reporting, candidates: top.map(keep) };
  }
  return {
    election_name: doc.election_name, percent_reporting: doc.percent_reporting,
    last_updated: doc.last_updated, test_data: doc.test_data,
    candidates: (doc.candidates ?? []).map(keep), region_results: rr,
  };
}

// What the page reads from another source's forecast: each race's rating and Democratic chance
// (null where the source publishes only a rating). Everything else is dropped.
// deno-lint-ignore no-explicit-any
function slimForecast(doc: any) {
  const states: Record<string, [string, number | null]> = {};
  // deno-lint-ignore no-explicit-any
  for (const [k, s] of Object.entries(doc.states ?? {}) as [string, any][]) states[k] = [s.rating, s.democrat_pct ?? null];
  return { last_updated: doc.last_updated, has_percentages: doc.has_percentages, states };
}

// civicAPI on election night (measured 2026-11-04): about half of requests answer 502 at once, and the
// ones that succeed take 11-15 s (the House document is 330 KB). A 10 s timeout therefore never let the
// Senate or Governors refresh. Each document now gets up to 8 tries inside one 45 s budget, with a growing
// pause (0.6 s, 1.2 s, ...): at 03:17 four quick tries all met 502s within two seconds and the refresh gave up.
async function getJSON(path: string) {
  const deadline = Date.now() + FETCH_BUDGET_MS;
  let err: unknown = new Error(`${path} -> no time left`);
  for (let n = 0; n < 8 && Date.now() < deadline - 2_000; n++) {
    try {
      const r = await fetch(`${BASE}/${path}`, {
        headers: { "User-Agent": "agwas-elections-cache/1.0 (elections.aguywithascarf.com)" },
        signal: AbortSignal.timeout(Math.min(25_000, deadline - Date.now())),
      });
      if (r.ok) return await r.json();
      err = new Error(`${path} -> ${r.status}`);
    } catch (e) {
      err = e;
    }
    await new Promise((done) => setTimeout(done, 600 * (n + 1)));
  }
  throw err;
}

// Each document is fetched on its own: one that fails (civicAPI 502s and timeouts under load) keeps
// the copy from the last stored body, so a bad Senate call no longer holds back fresh House numbers.
// If a failed document has no earlier copy, or every one failed, the whole refresh fails as before.
async function fetchUpstream(kind: Kind, prevBody: string | null): Promise<string> {
  const urls = SOURCES[kind].urls;
  const names = Object.keys(urls);
  const docs = await Promise.allSettled(Object.values(urls).map(getJSON));
  const prev = prevBody ? JSON.parse(prevBody) : null;
  const out: Record<string, unknown> = { ts: Date.now() };
  let ok = 0;
  names.forEach((name, i) => {
    const d = docs[i];
    const [src, chamber] = name.split(":");
    if (d.status === "fulfilled") {
      ok++;
      if (kind === "sources") ((out[src] ??= {}) as Record<string, unknown>)[chamber] = slimForecast(d.value);
      else out[name] = kind === "results" ? slimRace(d.value) : d.value;
      return;
    }
    const old = kind === "sources" ? prev?.[src]?.[chamber] : prev?.[name];
    if (old === undefined) throw d.reason;
    console.error("elections-cache kept previous", kind, name, String(d.reason));
    if (kind === "sources") ((out[src] ??= {}) as Record<string, unknown>)[chamber] = old;
    else out[name] = old;
  });
  if (!ok) throw new Error(`${kind}: every upstream document failed`);
  return JSON.stringify(out);
}

type Row = { ts_ms: number; body: string };

async function readRow(kind: Kind): Promise<Row | null> {
  const r = await fetch(`${TABLE}?kind=eq.${kind}&select=ts_ms,body`, {
    headers: DB, signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`read ${r.status}`);
  const rows = await r.json();
  return rows[0] ?? null;
}

// One conditional UPDATE: it only matches if the row is stale AND not locked, so of any number
// of simultaneous callers exactly one gets a row back.
async function tryLock(kind: Kind, now: number): Promise<boolean> {
  const q = `kind=eq.${kind}&ts_ms=lt.${now - SOURCES[kind].ttl}&lock_until_ms=lt.${now}&select=kind`;
  const r = await fetch(`${TABLE}?${q}`, {
    method: "PATCH",
    headers: { ...DB, Prefer: "return=representation" },
    body: JSON.stringify({ lock_until_ms: now + LOCK_MS }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`lock ${r.status}`);
  return (await r.json()).length === 1;
}

async function writeRow(kind: Kind, body: string) {
  const r = await fetch(`${TABLE}?kind=eq.${kind}`, {
    method: "PATCH", headers: DB,
    body: JSON.stringify({ ts_ms: Date.now(), body, lock_until_ms: 0 }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`write ${r.status}`);
}

async function refreshInBackground(kind: Kind, prevBody: string) {
  try {
    await writeRow(kind, await fetchUpstream(kind, prevBody));
  } catch (e) {
    console.error("elections-cache background refresh", kind, String(e));
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "X-Cache, X-Cache-Age",
};

function reply(kind: Kind, body: string, ts: number, state: string) {
  const ttlS = Math.round(SOURCES[kind].ttl / 1000);
  return new Response(body, {
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${Math.min(20, ttlS)}, s-maxage=${ttlS}, stale-while-revalidate=${ttlS * 2}`,
      "X-Cache": state,
      "X-Cache-Age": String(Math.max(0, Math.round((Date.now() - ts) / 1000))),
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: CORS });

  const kind = (new URL(req.url).searchParams.get("k") ?? "results") as Kind;
  if (!(kind in SOURCES)) return new Response('k must be "results", "forecast" or "sources"', { status: 400, headers: CORS });

  let row: Row | null = null;
  try {
    row = await readRow(kind);
    const now = Date.now();
    if (row?.body && now - row.ts_ms <= SOURCES[kind].ttl) return reply(kind, row.body, row.ts_ms, "hit");

    if (await tryLock(kind, now)) {
      // civicAPI takes 11-15 s per document under load, so the viewer who wins the lock must not wait for it:
      // serve the stored copy at once and refresh after the response (EdgeRuntime.waitUntil).
      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime;
      if (row?.body && rt?.waitUntil) {
        rt.waitUntil(refreshInBackground(kind, row.body));
        return reply(kind, row.body, row.ts_ms, "refreshing");
      }
      const body = await fetchUpstream(kind, row?.body ?? null);
      await writeRow(kind, body);
      return reply(kind, body, Date.now(), "miss");
    }
  } catch (e) {
    // civicAPI or the table failed: fall through to whatever we last had
    console.error("elections-cache", kind, String(e));
  }

  if (row?.body) return reply(kind, row.body, row.ts_ms, "stale");

  // Nothing stored yet (first ever request) and no lock: go to civicAPI directly, store nothing.
  try {
    return reply(kind, await fetchUpstream(kind, null), Date.now(), "direct");
  } catch (e) {
    console.error("elections-cache direct", kind, String(e));
    return new Response("upstream unavailable", { status: 502, headers: CORS });
  }
});
