// elections-cache: one shared cache between the midterms page and civicAPI.
//
//   GET .../elections-cache?k=results   -> {ts, house, senate, gov}  (the 3 national race documents)
//   GET .../elections-cache?k=forecast  -> {ts, house, senate, gov}  (the 3 civicAPI forecasts)
//
// Without this, every open browser tab asks civicAPI itself every minute. With it, civicAPI sees
// ONE set of three requests per TTL, however many people are watching.
//
// Why a table, not memory: Supabase starts a fresh instance for most requests, so an in-memory
// cache measured 1 hit in 22. The last good payload lives in public.elections_cache instead.
//
//   fresh row            -> serve it                                  (X-Cache: hit)
//   stale row, lock won  -> refresh from civicAPI, store, serve it    (X-Cache: miss)
//   stale row, lock lost -> serve the stale row, someone else is on it (X-Cache: stale)
//
// The lock is one conditional UPDATE (lock_until_ms in the past AND ts_ms older than the TTL),
// which Postgres applies to exactly one of any number of concurrent callers. If civicAPI fails
// the lock simply runs out, so a dead upstream is retried every LOCK_MS, not on every request.
//
// Safety: only the six fixed upstream URLs below are ever fetched (nothing from the request is
// interpolated into one). The service-role key stays inside the function. Public by design
// (verify_jwt = false): it serves only data civicAPI already publishes openly.

const BASE = "https://civicapi.org/api/v2";
const SOURCES = {
  results: {
    ttl: 30_000,
    urls: { house: "race/87524", senate: "race/87528", gov: "race/87535" },
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
const LOCK_MS = 20_000;

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

async function getJSON(path: string) {
  const r = await fetch(`${BASE}/${path}`, {
    headers: { "User-Agent": "agwas-elections-cache/1.0 (elections.aguywithascarf.com)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

async function fetchUpstream(kind: Kind): Promise<string> {
  const urls = SOURCES[kind].urls;
  const docs = await Promise.all(Object.values(urls).map(getJSON));
  const out: Record<string, unknown> = { ts: Date.now() };
  Object.keys(urls).forEach((name, i) => {
    out[name] = kind === "results" ? slimRace(docs[i]) : docs[i];
  });
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
  if (!(kind in SOURCES)) return new Response('k must be "results" or "forecast"', { status: 400, headers: CORS });

  let row: Row | null = null;
  try {
    row = await readRow(kind);
    const now = Date.now();
    if (row?.body && now - row.ts_ms <= SOURCES[kind].ttl) return reply(kind, row.body, row.ts_ms, "hit");

    if (await tryLock(kind, now)) {
      const body = await fetchUpstream(kind);
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
    return reply(kind, await fetchUpstream(kind), Date.now(), "direct");
  } catch (e) {
    console.error("elections-cache direct", kind, String(e));
    return new Response("upstream unavailable", { status: 502, headers: CORS });
  }
});
