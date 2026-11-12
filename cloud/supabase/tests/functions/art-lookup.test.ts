/* Unit tests for the art-lookup handler: in-memory DB that mimics the SQL
 * helpers in migrations/20261110103456_art_cache.sql, and a mocked SteamGridDB fetch.
 *
 *   cd cloud/supabase && deno test tests/functions/
 *
 * No network, no Supabase needed.
 */
// deno-lint-ignore no-import-prefix
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import {
  type ArtDb,
  createHandler,
  type Deps,
  type Game,
  type IndexRow,
  rank,
  type RateVerdict,
  type StoredGame,
  type StoredPage,
  type StoredSearch,
} from "../../functions/art-lookup/lib.ts";

// ------------------------------------------------------------- fake DB

class FakeDb implements ArtDb {
  index = new Map<string, IndexRow>();
  games = new Map<number, StoredGame>();
  inflight = new Map<string, number>();
  requests: { uid: string; at: number }[] = [];
  pages = new Map<string, StoredPage>();
  searches = new Map<string, StoredSearch>();
  searchRequests: { uid: string; at: number }[] = [];
  storeCalls = 0;
  storePageCalls = 0;
  constructor(public now: () => number) {}

  async getIndex(key: string) {
    await tick();
    return structuredClone(this.index.get(key) ?? null);
  }
  async getGame(id: number) {
    await tick();
    return structuredClone(this.games.get(id) ?? null);
  }
  async claim(key: string, ttl: number) {
    await tick();
    const at = this.inflight.get(key);
    if (at != null && this.now() - at < ttl * 1000) return false;
    this.inflight.set(key, this.now());
    return true;
  }
  async release(key: string) {
    await tick();
    this.inflight.delete(key);
  }
  async store(game: Omit<StoredGame, "fetchedAt">, keys: string[], candidates: Game[] | null, claimKey: string) {
    await tick();
    this.storeCalls++;
    const prev = this.games.get(game.sgdbId);
    const iso = new Date(this.now()).toISOString();
    this.games.set(game.sgdbId, structuredClone({ ...game, steamAppId: game.steamAppId ?? prev?.steamAppId ?? null, fetchedAt: iso }));
    for (const k of keys) {
      const old = this.index.get(k);
      this.index.set(k, {
        sgdbId: game.sgdbId,
        candidates: k.startsWith("term:") ? (candidates ?? old?.candidates ?? null) : null,
        createdAt: iso,
      });
    }
    this.inflight.delete(claimKey);
  }
  async storeMiss(key: string, claimKey: string) {
    await tick();
    this.index.set(key, { sgdbId: null, candidates: null, createdAt: new Date(this.now()).toISOString() });
    this.inflight.delete(claimKey);
  }
  async getPage(id: number, kind: string, page: number) {
    await tick();
    return structuredClone(this.pages.get(`${id}:${kind}:${page}`) ?? null);
  }
  async storePage(id: number, kind: string, page: number, items: StoredPage["items"], hasMore: boolean, claimKey: string) {
    await tick();
    this.storePageCalls++;
    this.pages.set(`${id}:${kind}:${page}`, structuredClone({ items, hasMore, fetchedAt: new Date(this.now()).toISOString() }));
    this.inflight.delete(claimKey);
  }
  async rateCheck(uid: string, hourLimit: number, dailyCap: number): Promise<RateVerdict> {
    await tick();
    const t = this.now();
    if (this.requests.filter((r) => r.uid === uid && t - r.at < 3600_000).length >= hourLimit) return "user";
    if (this.requests.filter((r) => t - r.at < 86400_000).length >= dailyCap) return "global";
    this.requests.push({ uid, at: t });
    return "ok";
  }
  async getSearch(term: string) {
    await tick();
    return structuredClone(this.searches.get(term) ?? null);
  }
  async storeSearch(term: string, candidates: Game[]) {
    await tick();
    this.searches.set(term, structuredClone({ candidates, fetchedAt: new Date(this.now()).toISOString() }));
  }
  async searchRateCheck(uid: string, hourLimit: number, dailyCap: number): Promise<RateVerdict> {
    await tick();
    const t = this.now();
    if (this.searchRequests.filter((r) => r.uid === uid && t - r.at < 3600_000).length >= hourLimit) return "user";
    if (this.searchRequests.filter((r) => t - r.at < 86400_000).length >= dailyCap) return "global";
    this.searchRequests.push({ uid, at: t });
    return "ok";
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

// ----------------------------------------------------------- fake SGDB

interface SgdbGame {
  id: number;
  name: string;
  steam?: number;
}

function fakeSgdb(games: SgdbGame[], opts: { failKinds?: boolean } = {}) {
  const calls: string[] = [];
  const asset = (id: number, w: number, h: number, extra: Record<string, unknown> = {}) => ({
    id,
    url: `https://cdn2.steamgriddb.com/x/${id}.png`,
    thumb: `https://cdn2.steamgriddb.com/thumb/${id}.png`,
    width: w,
    height: h,
    style: "alternate",
    nsfw: false,
    humor: false,
    epilepsy: false,
    score: 0,
    upvotes: 0,
    mime: "image/png",
    ...extra,
  });
  const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
  const nf = () => new Response(JSON.stringify({ success: false, errors: ["Game not found"] }), { status: 404 });

  const fetchMock = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace("/api/v2", "");
    calls.push(path + url.search);
    await tick();
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/games\/steam\/(\d+)$/))) {
      const g = games.find((x) => x.steam === Number(m![1]));
      return g ? ok({ id: g.id, name: g.name, release_date: 1, types: ["steam"], verified: true }) : nf();
    }
    if ((m = path.match(/^\/games\/id\/(\d+)$/))) {
      const g = games.find((x) => x.id === Number(m![1]));
      return g ? ok({ id: g.id, name: g.name, verified: true }) : nf();
    }
    if ((m = path.match(/^\/search\/autocomplete\/(.+)$/))) {
      const t = decodeURIComponent(m[1]).toLowerCase();
      return ok(games.filter((g) => g.name.toLowerCase().includes(t)).map((g) => ({ id: g.id, name: g.name })));
    }
    if ((m = path.match(/^\/(grids|heroes|logos|icons)\/game\/(\d+)$/))) {
      if (opts.failKinds) return new Response("oops", { status: 500 });
      const base = Number(m[2]) * 100;
      const pageParam = url.searchParams.get("page");
      if (pageParam != null && url.searchParams.get("limit") != null) {
        // Picker paging: page 0 is a full page of 50 (2 unsafe), page 1 has 10.
        const p = Number(pageParam);
        const n = p === 0 ? 50 : p === 1 ? 10 : 0;
        return ok(Array.from({ length: n }, (_, i) =>
          asset(100_000 * (p + 1) + i, 600, 900, i === 0 ? { nsfw: true } : i === 1 ? { humor: true } : {})
        ));
      }
      if (m[1] === "grids") {
        return ok([
          asset(base + 1, 920, 430), // wrong ratio
          asset(base + 2, 600, 900, { nsfw: true }), // filtered
          asset(base + 3, 600, 900, { style: "official", score: 5 }), // best
          ...Array.from({ length: 12 }, (_, i) => asset(base + 10 + i, 600, 900)),
        ]);
      }
      if (m[1] === "heroes") return ok([asset(base + 50, 1920, 620)]);
      if (m[1] === "logos") return ok([asset(base + 60, 800, 300, { humor: true }), asset(base + 61, 800, 300)]);
      return ok([asset(base + 70, 512, 512)]);
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  return { fetchMock, calls };
}

// --------------------------------------------------------------- setup

const GAMES: SgdbGame[] = [
  { id: 7, name: "Counter-Strike 2", steam: 730 },
  { id: 8, name: "God of War", steam: 1593500 },
  { id: 9, name: "God of War Ragnarok" },
];

function setup(over: Partial<Deps> & { failKinds?: boolean } = {}) {
  let clock = Date.parse("2026-11-10T12:00:00Z");
  const now = () => clock;
  const db = new FakeDb(now);
  const sgdb = fakeSgdb(GAMES, { failKinds: over.failKinds });
  const handler = createHandler({
    db,
    sgdbKey: "test-key",
    fetch: sgdb.fetchMock,
    verifyUser: (token) => Promise.resolve(token.startsWith("user-") ? token : null),
    now,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    pollMs: 2,
    waitMs: 2000,
    log: () => {},
    ...over,
  });
  const call = async (body: unknown, token = "user-a") => {
    const res = await handler(
      new Request("http://local/art-lookup", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { db, sgdb, call, advance: (ms: number) => (clock += ms) };
}

// --------------------------------------------------------------- tests

Deno.test("miss -> fetches from SGDB and writes once; hit -> no SGDB call", async () => {
  const { db, sgdb, call } = setup();
  const first = await call({ steamAppId: 730 });
  assertEquals(first.status, 200);
  assertEquals(first.body.ok, true);
  assertEquals(first.body.data.source, "sgdb");
  assertEquals(first.body.data.game.id, 7);
  assertEquals(first.body.data.game.steamAppId, 730);
  assertEquals(db.storeCalls, 1);
  assertEquals(db.index.get("steam:730")?.sgdbId, 7);
  const callsAfterMiss = sgdb.calls.length;
  assertEquals(callsAfterMiss, 5); // game + 4 kinds
  const gridCall = sgdb.calls.find((c) => c.startsWith("/grids/game/7?"))!;
  for (const f of ["nsfw=false", "humor=false", "dimensions=600x900%2C342x482%2C660x930", "mimes=image%2Fpng%2Cimage%2Fjpeg%2Cimage%2Fwebp"]) {
    assert(gridCall.includes(f), `grids request should send ${f}: ${gridCall}`);
  }

  const second = await call({ steamAppId: 730 }, "user-b");
  assertEquals(second.status, 200);
  assertEquals(second.body.data.source, "cache");
  assertEquals(sgdb.calls.length, callsAfterMiss, "cache hit must not call SteamGridDB");
  assertEquals(db.storeCalls, 1);
  assertEquals(db.requests.length, 1, "hits do not count toward rate limits");

  // Same game by sgdbId is also a hit (art_games pk lookup).
  const third = await call({ sgdbId: 7 });
  assertEquals(third.body.data.source, "cache");
  assertEquals(sgdb.calls.length, callsAfterMiss);
});

Deno.test("response matches desktop sgdb.js shapes; ranking + nsfw/humor filtered, max 8", async () => {
  const { call } = setup();
  const { body } = await call({ steamAppId: 730 });
  const d = body.data;
  assertEquals(Object.keys(d.game).sort(), ["id", "name", "releaseDate", "steamAppId", "types", "verified"]);
  assertEquals(Object.keys(d.assets).sort(), ["grids", "heroes", "icons", "logos"]);
  for (const k of ["grids", "heroes", "logos", "icons"]) {
    assertEquals(Object.keys(d.assets[k]).sort(), ["hasMore", "items", "total"]);
  }
  assertEquals(
    Object.keys(d.top.cover).sort(),
    ["epilepsy", "height", "humor", "id", "mime", "nsfw", "score", "style", "thumb", "upvotes", "url", "width"],
  );
  assertEquals(d.top.cover.id, 703, "official 600x900 wins");
  assertEquals(d.assets.grids.items.length, 8);
  assertEquals(d.assets.grids.total, 14, "15 raw - 1 nsfw");
  assert(!d.assets.grids.items.some((a: { id: number }) => a.id === 702), "nsfw filtered");
  assertEquals(d.top.logo.id, 761, "humor filtered");
  assertEquals(d.top.hero.id, 750);
  assertEquals(d.top.icon.id, 770);
});

Deno.test("concurrent misses for one key hit SGDB once", async () => {
  const { db, sgdb, call } = setup();
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call({ steamAppId: 730 }, `user-${i}`)));
  for (const r of results) assertEquals(r.status, 200);
  assertEquals(sgdb.calls.filter((c) => c === "/games/steam/730").length, 1);
  assertEquals(db.storeCalls, 1);
  assertEquals(results.filter((r) => r.body.data.source === "sgdb").length, 1);
});

Deno.test("term lookup: exact name match wins, candidates returned, cached by term", async () => {
  const { sgdb, call } = setup();
  const r = await call({ term: "  GOD   of war " });
  assertEquals(r.status, 200);
  assertEquals(r.body.data.game.id, 8);
  assertEquals(r.body.data.candidates.map((c: Game) => c.id), [8, 9]);
  const n = sgdb.calls.length;
  const again = await call({ term: "god of war" });
  assertEquals(again.body.data.source, "cache");
  assertEquals(again.body.data.candidates.length, 2);
  assertEquals(sgdb.calls.length, n);
});

Deno.test("unknown steam id falls back to term, like desktop sgdb:resolve", async () => {
  const { db, call } = setup();
  const r = await call({ steamAppId: 999999, term: "God of War Ragnarok" });
  assertEquals(r.status, 200);
  assertEquals(r.body.data.game.id, 9);
  assertEquals(db.index.get("steam:999999")?.sgdbId, null, "steam miss negatively cached");
});

Deno.test("not found is negatively cached (no second SGDB call)", async () => {
  const { sgdb, call } = setup();
  const r = await call({ steamAppId: 424242 });
  assertEquals(r.status, 404);
  assertEquals(r.body, { ok: false, error: { code: "NOT_FOUND", message: "Nothing found on SteamGridDB" } });
  const n = sgdb.calls.length;
  const again = await call({ steamAppId: 424242 });
  assertEquals(again.status, 404);
  assertEquals(sgdb.calls.length, n);
});

Deno.test("per-user hourly limit -> 429, other users unaffected, resets after an hour", async () => {
  const { call, advance } = setup({ hourLimit: 2 });
  assertEquals((await call({ sgdbId: 7 })).status, 200);
  assertEquals((await call({ sgdbId: 8 })).status, 200);
  const limited = await call({ sgdbId: 9 });
  assertEquals(limited.status, 429);
  assertEquals(limited.body.error.code, "RATE_LIMIT");
  assert(limited.body.error.message.includes("2 new games per hour"));
  assert(limited.headers.get("retry-after"));
  assertEquals((await call({ sgdbId: 7 })).status, 200, "cache hits still served while limited");
  assertEquals((await call({ sgdbId: 9 }, "user-other")).status, 200);
  advance(3601_000);
  assertEquals((await call({ term: "counter" })).status, 200);
});

Deno.test("global daily cap -> 429 for everyone", async () => {
  const { call } = setup({ dailyCap: 1 });
  assertEquals((await call({ sgdbId: 7 }, "user-1")).status, 200);
  const r = await call({ sgdbId: 8 }, "user-2");
  assertEquals(r.status, 429);
  assert(r.body.error.message.includes("today's limit"));
});

Deno.test("auth: missing / anon-key / bad token -> 401, no DB or SGDB work", async () => {
  const { sgdb, call } = setup();
  assertEquals((await call({ steamAppId: 730 }, "")).status, 401);
  const r = await call({ steamAppId: 730 }, "eyJ-anon-key");
  assertEquals(r.status, 401);
  assertEquals(r.body.error.code, "UNAUTHENTICATED");
  assertEquals(sgdb.calls.length, 0);
});

Deno.test("bad input -> 400", async () => {
  const { call } = setup();
  assertEquals((await call({})).status, 400);
  assertEquals((await call({ steamAppId: -3 })).status, 400);
  assertEquals((await call({ term: "x".repeat(101) })).status, 400);
  assertEquals((await call("nope")).status, 400);
});

Deno.test("stale (>30 days) entry is refreshed by id; if limited, stale data is served", async () => {
  const { db, sgdb, call, advance } = setup({ hourLimit: 1 });
  await call({ steamAppId: 730 }); // uses the user's only miss this hour
  advance(31 * 24 * 3600_000);
  // New hour, so refresh is allowed: one call by id, no /games/steam.
  const before = sgdb.calls.length;
  const r = await call({ steamAppId: 730 });
  assertEquals(r.body.data.source, "sgdb");
  assert(sgdb.calls.slice(before).includes("/games/id/7"));
  assertEquals(db.storeCalls, 2);

  advance(31 * 24 * 3600_000);
  await call({ sgdbId: 8 }); // burn this hour's miss
  const stale = await call({ steamAppId: 730 });
  assertEquals(stale.status, 200);
  assertEquals(stale.body.data.stale, true);
  assertEquals(stale.body.data.game.id, 7);
});

Deno.test("transient SGDB failure is not cached and frees the claim", async () => {
  const { db, call } = setup({ failKinds: true });
  const r = await call({ steamAppId: 730 });
  assertEquals(r.status, 502);
  assertEquals(r.body.error.code, "NETWORK");
  assertEquals(db.games.size, 0);
  assertEquals(db.index.size, 0);
  assertEquals(db.inflight.size, 0);
});

Deno.test("rank() port: covers prefer 2:3 >= 600 wide, then style, then score (desktop parity)", () => {
  const a = (id: number, w: number, h: number, style = "alternate", score = 0) => ({ id, url: `u${id}`, width: w, height: h, style, score });
  const out = rank("grids", [a(1, 342, 482, "official"), a(2, 600, 900, "blurred"), a(3, 600, 900, "official", 1), a(4, 920, 430, "official", 99)]);
  // 342x482 is ratio 0.71: outside the desktop's +-0.04 band around 2:3, so it
  // scores 40+20 and lands below the wide 920x430 (40+0). Parity with sgdb.js.
  assertEquals(out.map((x) => x.id), [3, 2, 4, 1]);
});

Deno.test("picker paging: page miss fetched once and cached, SGDB order kept, unsafe removed", async () => {
  const { db, sgdb, call } = setup();
  await call({ steamAppId: 730 }); // game row exists
  const before = sgdb.calls.length;

  const p0 = await call({ sgdbId: 7, kind: "grids", page: 0 });
  assertEquals(p0.status, 200);
  assertEquals(p0.body.data.source, "sgdb");
  assertEquals(p0.body.data.game, { id: 7, name: "Counter-Strike 2" });
  assertEquals(p0.body.data.items.length, 48, "50 raw - 1 nsfw - 1 humor");
  assertEquals(p0.body.data.items[0].id, 100_002, "SteamGridDB order, not re-ranked");
  assertEquals(p0.body.data.total, 48);
  assertEquals(p0.body.data.hasMore, true);
  const pageCall = sgdb.calls.slice(before).find((c) => c.startsWith("/grids/game/7?"))!;
  assert(pageCall.includes("page=0") && pageCall.includes("limit=50") && pageCall.includes("nsfw=false"), pageCall);
  assertEquals(sgdb.calls.length, before + 1, "game row was a cache hit; only the page was fetched");

  const again = await call({ sgdbId: 7, kind: "grids", page: 0 }, "user-b");
  assertEquals(again.body.data.source, "cache");
  assertEquals(sgdb.calls.length, before + 1);
  assertEquals(db.storePageCalls, 1);

  const p1 = await call({ sgdbId: 7, kind: "grids", page: 1 });
  assertEquals(p1.body.data.items.length, 8, "10 raw - 2 unsafe");
  assertEquals(p1.body.data.hasMore, false);
});

Deno.test("picker paging: game not cached yet is fetched first; bad paging input -> 400", async () => {
  const { db, call } = setup();
  const r = await call({ sgdbId: 8, kind: "heroes", page: 0 });
  assertEquals(r.status, 200);
  assert(db.games.has(8), "game row created so the page can reference it");
  assertEquals((await call({ steamAppId: 730, kind: "grids", page: 0 })).status, 400, "paging needs sgdbId");
  assertEquals((await call({ sgdbId: 7, kind: "posters", page: 0 })).status, 400);
  assertEquals((await call({ sgdbId: 7, kind: "grids", page: 50 })).status, 400);
  assertEquals((await call({ sgdbId: 7, kind: "grids", page: -1 })).status, 400);
});

Deno.test("rows stored under an older ASSETS_SCHEMA are refreshed", async () => {
  const { db, sgdb, call } = setup();
  await call({ steamAppId: 730 });
  const row = db.games.get(7)!;
  row.assets = { ...row.assets, v: 1 };
  const before = sgdb.calls.length;
  const r = await call({ steamAppId: 730 });
  assertEquals(r.body.data.source, "sgdb");
  assert(sgdb.calls.slice(before).includes("/games/id/7"), "refreshed by id");
  assertEquals(db.games.get(7)!.assets.v, 2);
});

// ------------------------------------------------------------ title search

Deno.test("search: one autocomplete call, cached per term, no artwork fetched", async () => {
  const { db, sgdb, call } = setup();
  const first = await call({ search: "  Counter " });
  assertEquals(first.status, 200);
  assertEquals(first.body.data.term, "counter");
  assertEquals(first.body.data.source, "sgdb");
  assert(first.body.data.candidates.length >= 1);
  assertEquals(first.body.data.candidates[0].name.toLowerCase().includes("counter"), true);
  assertEquals(sgdb.calls.length, 1, "only the autocomplete call");
  assertEquals(db.searchRequests.length, 1);
  assertEquals(db.requests.length, 0, "searches never touch the game bucket");

  const again = await call({ search: "COUNTER" }, "user-b");
  assertEquals(again.body.data.source, "cache");
  assertEquals(sgdb.calls.length, 1);
  assertEquals(db.searchRequests.length, 1, "cache hits are free");
});

Deno.test("search: own hourly limit, separate from game lookups", async () => {
  const { call, advance } = setup({ hourLimit: 1, searchHourLimit: 2 });
  assertEquals((await call({ sgdbId: 7 })).status, 200);
  assertEquals((await call({ sgdbId: 8 })).status, 429, "game bucket is full");
  assertEquals((await call({ search: "counter" })).status, 200, "search still works");
  assertEquals((await call({ search: "half" })).status, 200);
  const limited = await call({ search: "portal" });
  assertEquals(limited.status, 429);
  assertEquals(limited.body.error.code, "RATE_LIMIT");
  assert(limited.body.error.message.includes("2 searches per hour"));
  assertEquals((await call({ search: "counter" })).status, 200, "cached terms still answer");
  advance(3601_000);
  assertEquals((await call({ search: "portal" })).status, 200);
});

Deno.test("search: empty results are cached; stale terms are refreshed", async () => {
  const { db, sgdb, call, advance } = setup();
  const none = await call({ search: "zzzz nothing" });
  assertEquals(none.status, 200);
  assertEquals(none.body.data.candidates, []);
  assert(db.searches.has("zzzz nothing"));
  await call({ search: "counter" });
  advance(8 * 24 * 3600_000);
  const before = sgdb.calls.length;
  const res = await call({ search: "counter" }, "user-c");
  assertEquals(res.status, 200);
  assertEquals(sgdb.calls.length, before + 1, "stale term is refreshed");
});

Deno.test("search: input validation", async () => {
  const { call } = setup();
  assertEquals((await call({ search: 5 })).status, 400);
  assertEquals((await call({ search: "   " })).status, 400);
  assertEquals((await call({ search: "x".repeat(101) })).status, 400);
});
