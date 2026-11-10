/* art-lookup core: everything except the Supabase wiring, so tests can run it
 * against an in-memory DB and a mocked fetch. See index.ts for the response
 * shape.
 *
 * Ranking (STYLE_RANK, fit(), rank(), normalizeGame/normalizeAsset) is a port
 * of src/backend/sgdb.js. Keep the two in step.
 */

export const SGDB_BASE = "https://www.steamgriddb.com/api/v2";

export const ASSET_KINDS = ["grids", "heroes", "logos", "icons"] as const;
export type AssetKind = typeof ASSET_KINDS[number];

/** Desktop `sgdb:autofill` slot name for each kind. */
export const SLOT_OF: Record<AssetKind, "cover" | "hero" | "logo" | "icon"> = {
  grids: "cover",
  heroes: "hero",
  logos: "logo",
  icons: "icon",
};

export const ITEMS_PER_KIND = 8;
export const FRESH_MS = 30 * 24 * 60 * 60 * 1000; // refresh after 30 days
export const NEGATIVE_MS = 7 * 24 * 60 * 60 * 1000; // re-ask SGDB about a miss after 7 days
export const CLAIM_TTL_S = 30;
/** Bump when stored asset shape or SGDB filters change: older rows count as stale. */
export const ASSETS_SCHEMA = 2;
export const PAGE_SIZE = 50; // SteamGridDB's page size
export const MAX_PAGE = 49;

/** Filters sent to SteamGridDB so it only returns what we can show (as Hydra does). */
export const KIND_PARAMS: Record<AssetKind, Record<string, string>> = {
  grids: {
    nsfw: "false",
    humor: "false",
    dimensions: "600x900,342x482,660x930",
    mimes: "image/png,image/jpeg,image/webp",
  },
  heroes: { nsfw: "false", humor: "false", mimes: "image/png,image/jpeg,image/webp" },
  logos: { nsfw: "false", humor: "false", mimes: "image/png,image/webp" },
  icons: { nsfw: "false", humor: "false", mimes: "image/png,image/vnd.microsoft.icon" },
};

// ------------------------------------------------------------------ types

/** Same shape as normalizeGame() in src/backend/sgdb.js. */
export interface Game {
  id: number;
  name: string;
  releaseDate: number | null;
  types: string[];
  verified: boolean;
}

/** Same shape as normalizeAsset() in src/backend/sgdb.js. */
export interface Asset {
  id: number;
  url: string;
  thumb: string;
  width: number;
  height: number;
  style: string;
  nsfw: boolean;
  humor: boolean;
  epilepsy: boolean;
  score: number;
  upvotes: number;
  mime: string;
}

/** Same shape as sgdb.assets() in src/backend/sgdb.js (items capped at 8). */
export interface AssetPage {
  items: Asset[];
  total: number;
  hasMore: boolean;
}

export type AssetSet = Record<AssetKind, AssetPage>;

/** What art_games.assets holds. */
export interface StoredAssets extends AssetSet {
  v: number;
}

export interface StoredGame {
  sgdbId: number;
  name: string;
  steamAppId: number | null;
  info: { releaseDate: number | null; types: string[]; verified: boolean };
  assets: StoredAssets;
  fetchedAt: string; // ISO
}

export interface IndexRow {
  sgdbId: number | null; // null = negative cache
  candidates: Game[] | null;
  createdAt: string; // ISO
}

export interface StoredPage {
  items: Asset[];
  hasMore: boolean;
  fetchedAt: string; // ISO
}

export type RateVerdict = "ok" | "user" | "global";

/** Thin DB surface; index.ts implements it with supabase-js + the SQL RPCs. */
export interface ArtDb {
  getIndex(key: string): Promise<IndexRow | null>;
  getGame(sgdbId: number): Promise<StoredGame | null>;
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  release(key: string): Promise<void>;
  store(game: Omit<StoredGame, "fetchedAt">, keys: string[], candidates: Game[] | null, claimKey: string): Promise<void>;
  storeMiss(key: string, claimKey: string): Promise<void>;
  getPage(sgdbId: number, kind: AssetKind, page: number): Promise<StoredPage | null>;
  storePage(sgdbId: number, kind: AssetKind, page: number, items: Asset[], hasMore: boolean, claimKey: string): Promise<void>;
  rateCheck(uid: string, hourLimit: number, dailyCap: number): Promise<RateVerdict>;
}

export interface Deps {
  db: ArtDb;
  /** Resolve a bearer token to a Supabase user id, or null if invalid. */
  verifyUser(token: string): Promise<string | null>;
  sgdbKey: string;
  fetch?: typeof fetch;
  hourLimit?: number; // misses per uid per hour, default 60
  dailyCap?: number; // misses per rolling 24 h, all users, default 2000
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number; // how long a loser of a claim waits for the winner, default 8000
  pollMs?: number; // default 400
  log?: (msg: string, extra?: unknown) => void;
}

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "RATE_LIMIT"
  | "BUSY"
  | "NETWORK"
  | "SERVER";

const STATUS_OF: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  RATE_LIMIT: 429,
  BUSY: 503,
  NETWORK: 502,
  SERVER: 500,
};

export class ArtError extends Error {
  constructor(public code: ErrorCode, message: string, public retryAfter?: number) {
    super(message);
  }
}

export interface LookupInput {
  steamAppId?: number;
  sgdbId?: number;
  term?: string;
  /** Picker paging: with sgdbId, return one raw SteamGridDB page of this kind. */
  kind?: AssetKind;
  page?: number;
}

/** Response for a { sgdbId, kind, page } request. items/total/hasMore = sgdb.assets(). */
export interface PageData {
  game: { id: number; name: string };
  kind: AssetKind;
  page: number;
  items: Asset[];
  total: number;
  hasMore: boolean;
  source: "cache" | "sgdb";
  stale: boolean;
  fetchedAt: string;
}

export interface LookupData {
  game: Game & { steamAppId: number | null };
  top: Record<"cover" | "hero" | "logo" | "icon", Asset | null>;
  assets: AssetSet;
  candidates: Game[];
  source: "cache" | "sgdb";
  stale: boolean;
  fetchedAt: string;
}

// -------------------------------------------- port of src/backend/sgdb.js

// deno-lint-ignore no-explicit-any
type Raw = any;

export function normalizeGame(game: Raw): Game {
  return {
    id: game.id,
    name: game.name,
    releaseDate: game.release_date || null,
    types: game.types || [],
    verified: !!game.verified,
  };
}

export function normalizeAsset(asset: Raw): Asset {
  return {
    id: asset.id,
    url: asset.url,
    thumb: asset.thumb || asset.url,
    width: asset.width || 0,
    height: asset.height || 0,
    style: Array.isArray(asset.style) ? asset.style[0] : (asset.style || ""),
    nsfw: !!asset.nsfw,
    humor: !!asset.humor,
    epilepsy: !!asset.epilepsy,
    score: asset.score || 0,
    upvotes: asset.upvotes || 0,
    mime: asset.mime || "",
  };
}

export const STYLE_RANK: Record<string, number> = {
  official: 0,
  alternate: 1,
  no_logo: 1,
  nologo: 1,
  white_logo: 2,
  material: 2,
  blurred: 3,
};

export function rank(kind: AssetKind, list: Raw[] | null | undefined): Asset[] {
  const safe = (list || [])
    .filter((item: Raw) => !item.nsfw && !item.humor && !item.epilepsy)
    .map(normalizeAsset);

  const fit = (a: Asset) => {
    const ratio = a.height ? a.width / a.height : 1;
    if (kind === "grids") {
      const close = Math.abs(ratio - 2 / 3) < 0.04;
      return (close ? 0 : 40) + (a.width >= 600 ? 0 : 20);
    }
    if (kind === "heroes") return ratio >= 1.45 ? 0 : 100;
    if (kind === "icons") return Math.abs(ratio - 1) < 0.05 ? (a.width >= 256 ? 0 : 10) : 100;
    if (kind === "logos") return a.width >= 400 ? 0 : 20;
    return 0;
  };

  return safe.slice().sort((a, b) => {
    const fitA = fit(a);
    const fitB = fit(b);
    if (fitA !== fitB) return fitA - fitB;
    const styleA = STYLE_RANK[a.style] ?? 2;
    const styleB = STYLE_RANK[b.style] ?? 2;
    if (styleA !== styleB) return styleA - styleB;
    if (b.score !== a.score) return b.score - a.score;
    return b.upvotes - a.upvotes;
  });
}

/** Ported classify(); AUTH becomes SERVER because the key is ours, not the user's. */
function classify(status: number, json: Raw): ArtError | null {
  if (status === 401 || status === 403) return new ArtError("SERVER", "SteamGridDB rejected the server's API key");
  if (status === 429) return new ArtError("RATE_LIMIT", "SteamGridDB is rate limiting the shared cache; try again shortly", 60);
  if (status === 404) return new ArtError("NOT_FOUND", "Nothing found on SteamGridDB");
  if (status >= 500) return new ArtError("NETWORK", `SteamGridDB error ${status}`);
  if (!json) return new ArtError("NETWORK", "SteamGridDB returned an invalid response");
  if (json.success === false) {
    const message = Array.isArray(json.errors) ? json.errors.join(", ") : "SteamGridDB request failed";
    return new ArtError("NETWORK", message);
  }
  return null;
}

// ------------------------------------------------------------- helpers

export function normalizeTerm(term: string): string {
  return term.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function positiveInt(v: unknown): number | undefined {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function parseInput(body: unknown): LookupInput {
  if (!body || typeof body !== "object") throw new ArtError("BAD_REQUEST", "Send a JSON object: { steamAppId?, sgdbId?, term? }");
  const b = body as Record<string, unknown>;
  const out: LookupInput = {};
  if (b.steamAppId != null) {
    out.steamAppId = positiveInt(b.steamAppId);
    if (!out.steamAppId || out.steamAppId > 2_147_483_647) throw new ArtError("BAD_REQUEST", "steamAppId must be a positive integer");
  }
  if (b.sgdbId != null) {
    out.sgdbId = positiveInt(b.sgdbId);
    if (!out.sgdbId) throw new ArtError("BAD_REQUEST", "sgdbId must be a positive integer");
  }
  if (b.term != null) {
    if (typeof b.term !== "string") throw new ArtError("BAD_REQUEST", "term must be a string");
    const t = normalizeTerm(b.term);
    if (t.length > 100) throw new ArtError("BAD_REQUEST", "term is too long (max 100 characters)");
    if (t) out.term = t;
  }
  if (b.kind != null || b.page != null) {
    if (!ASSET_KINDS.includes(b.kind as AssetKind)) throw new ArtError("BAD_REQUEST", "kind must be one of grids, heroes, logos, icons");
    const page = b.page == null || b.page === 0 || b.page === "0" ? 0 : positiveInt(b.page);
    if (page == null || page > MAX_PAGE) throw new ArtError("BAD_REQUEST", `page must be an integer from 0 to ${MAX_PAGE}`);
    if (!out.sgdbId) throw new ArtError("BAD_REQUEST", "Paging needs sgdbId (take it from a normal lookup's data.game.id)");
    out.kind = b.kind as AssetKind;
    out.page = page;
  }
  if (!out.steamAppId && !out.sgdbId && !out.term) {
    throw new ArtError("BAD_REQUEST", "Give at least one of steamAppId, sgdbId or term");
  }
  return out;
}

function emptyPage(): AssetPage {
  return { items: [], total: 0, hasMore: false };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...headers },
  });
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

function errorResponse(err: ArtError): Response {
  const headers: Record<string, string> = {};
  if (err.retryAfter) headers["retry-after"] = String(err.retryAfter);
  return json(STATUS_OF[err.code], { ok: false, error: { code: err.code, message: err.message } }, headers);
}

// ----------------------------------------------------------- the handler

type Source =
  | { kind: "sgdb"; id: number; steamAppId: number | null }
  | { kind: "steam"; appId: number }
  | { kind: "term"; term: string };

type CacheState =
  | { kind: "hit"; game: StoredGame; candidates: Game[]; fresh: boolean }
  | { kind: "negative"; fresh: boolean }
  | null;

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  const db = deps.db;
  const doFetch = deps.fetch ?? fetch;
  const hourLimit = deps.hourLimit ?? 60;
  const dailyCap = deps.dailyCap ?? 2000;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = deps.waitMs ?? 8000;
  const pollMs = deps.pollMs ?? 400;
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.log(msg, extra ?? ""));

  // ---- SteamGridDB

  async function sgdbGet(path: string, params: Record<string, string> = {}): Promise<Raw> {
    if (!deps.sgdbKey) throw new ArtError("SERVER", "SGDB_KEY is not set on the server (Edge Functions -> Secrets)");
    const qs = new URLSearchParams(params).toString();
    const url = `${SGDB_BASE}${path}${qs ? `?${qs}` : ""}`;
    let last: ArtError | null = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const res = await doFetch(url, {
          headers: { Authorization: `Bearer ${deps.sgdbKey}`, "User-Agent": "GameVault-ArtCache/2.0" },
          signal: AbortSignal.timeout(10_000),
        });
        let body: Raw = null;
        try {
          body = await res.json();
        } catch { /* classify() handles null */ }
        const failure = classify(res.status, body);
        if (!failure) return body.data;
        if (failure.code !== "RATE_LIMIT" && failure.code !== "NETWORK") throw failure;
        last = failure;
      } catch (err) {
        if (err instanceof ArtError && err.code !== "NETWORK" && err.code !== "RATE_LIMIT") throw err;
        last = err instanceof ArtError ? err : new ArtError("NETWORK", `SteamGridDB unreachable: ${(err as Error).message}`);
      }
      if (attempt < 1) await sleep(300);
    }
    throw last!;
  }

  async function fetchKind(kind: AssetKind, id: number): Promise<AssetPage> {
    const get = async (params: Record<string, string>) => {
      try {
        return (await sgdbGet(`/${kind}/game/${id}`, params)) as Raw[] | null;
      } catch (err) {
        if (err instanceof ArtError && err.code === "NOT_FOUND") return [];
        throw err; // never cache a hole caused by a transient failure
      }
    };
    // Covers: ask for portrait sizes first; if a game has none, drop the size
    // filter (rank() still prefers 2:3) so it still gets a cover.
    let raw = await get(KIND_PARAMS[kind]);
    if (kind === "grids" && !(raw || []).length) {
      const { dimensions: _d, ...rest } = KIND_PARAMS.grids;
      raw = await get(rest);
    }
    const ranked = rank(kind, raw || []);
    return {
      items: ranked.slice(0, ITEMS_PER_KIND),
      total: ranked.length,
      hasMore: (raw || []).length >= 50,
    };
  }

  function pickBest(term: string, hits: Game[]): Game | null {
    const exact = hits.find((h) => normalizeTerm(h.name || "") === term);
    return exact ?? hits[0] ?? null;
  }

  /** Returns null when SteamGridDB has no such game. */
  async function fetchFromSgdb(src: Source): Promise<{ game: Game; steamAppId: number | null; candidates: Game[] | null; assets: StoredAssets } | null> {
    let game: Game | null = null;
    let candidates: Game[] | null = null;
    let steamAppId: number | null = null;
    try {
      if (src.kind === "sgdb") {
        const d = await sgdbGet(`/games/id/${src.id}`);
        game = d ? normalizeGame(d) : null;
        steamAppId = src.steamAppId;
      } else if (src.kind === "steam") {
        const d = await sgdbGet(`/games/steam/${src.appId}`);
        game = d ? normalizeGame(d) : null;
        steamAppId = src.appId;
      } else {
        const d = (await sgdbGet(`/search/autocomplete/${encodeURIComponent(src.term)}`)) as Raw[] | null;
        candidates = (d || []).slice(0, 10).map(normalizeGame);
        game = pickBest(src.term, candidates);
      }
    } catch (err) {
      if (err instanceof ArtError && err.code === "NOT_FOUND") return null;
      throw err;
    }
    if (!game || !game.id) return null;

    const pages = await Promise.all(ASSET_KINDS.map((k) => fetchKind(k, game!.id)));
    const assets = { v: ASSETS_SCHEMA } as StoredAssets;
    ASSET_KINDS.forEach((k, i) => (assets[k] = pages[i]));
    return { game, steamAppId, candidates, assets };
  }

  // ---- cache

  function isFresh(iso: string, maxAge: number): boolean {
    const t = Date.parse(iso);
    return Number.isFinite(t) && now() - t < maxAge;
  }

  const gameFresh = (g: StoredGame) => g.assets?.v === ASSETS_SCHEMA && isFresh(g.fetchedAt, FRESH_MS);

  async function readCache(key: string): Promise<CacheState> {
    if (key.startsWith("sgdb:")) {
      const game = await db.getGame(Number(key.slice(5)));
      return game ? { kind: "hit", game, candidates: [], fresh: gameFresh(game) } : null;
    }
    const idx = await db.getIndex(key);
    if (!idx) return null;
    if (idx.sgdbId == null) return { kind: "negative", fresh: isFresh(idx.createdAt, NEGATIVE_MS) };
    const game = await db.getGame(idx.sgdbId);
    if (!game) return null;
    return { kind: "hit", game, candidates: idx.candidates || [], fresh: gameFresh(game) };
  }

  function toData(game: StoredGame, candidates: Game[], source: "cache" | "sgdb", stale: boolean): LookupData {
    const assets = {} as AssetSet;
    const top = {} as LookupData["top"];
    for (const k of ASSET_KINDS) {
      const page = game.assets?.[k] ?? emptyPage();
      assets[k] = page;
      top[SLOT_OF[k]] = page.items[0] ?? null;
    }
    return {
      game: {
        id: game.sgdbId,
        name: game.name,
        releaseDate: game.info?.releaseDate ?? null,
        types: game.info?.types ?? [],
        verified: !!game.info?.verified,
        steamAppId: game.steamAppId,
      },
      top,
      assets,
      candidates,
      source,
      stale,
      fetchedAt: game.fetchedAt,
    };
  }

  const notFound = () => new ArtError("NOT_FOUND", "Nothing found on SteamGridDB");

  async function waitForOther(key: string): Promise<CacheState> {
    const deadline = now() + waitMs;
    while (now() < deadline) {
      await sleep(pollMs);
      const state = await readCache(key);
      if (state && state.fresh) return state;
    }
    return null;
  }

  /** Cache-or-fetch for one lookup key ("steam:730", "term:x", "sgdb:123"). */
  async function lookupKey(key: string, src: Source, uid: string): Promise<LookupData> {
    const state = await readCache(key);
    if (state?.kind === "hit" && state.fresh) return toData(state.game, state.candidates, "cache", false);
    if (state?.kind === "negative" && state.fresh) throw notFound();

    const stale = state?.kind === "hit" ? state : null;
    const serveStale = (why: string) => {
      log(`art-lookup: serving stale ${key} (${why})`);
      return toData(stale!.game, stale!.candidates, "cache", true);
    };

    if (!(await db.claim(key, CLAIM_TTL_S))) {
      // Someone else is fetching this key right now: wait for their write.
      const after = await waitForOther(key);
      if (after?.kind === "hit") return toData(after.game, after.candidates, "cache", false);
      if (after?.kind === "negative") throw notFound();
      if (stale) return serveStale("busy");
      throw new ArtError("BUSY", "This game is being fetched by another request; retry in a few seconds", 5);
    }

    try {
      const verdict = await db.rateCheck(uid, hourLimit, dailyCap);
      if (verdict !== "ok") {
        await db.release(key);
        if (stale) return serveStale(`rate:${verdict}`);
        throw verdict === "user"
          ? new ArtError("RATE_LIMIT", `Artwork lookup limit reached (${hourLimit} new games per hour). Cached games still load; try again later.`, 900)
          : new ArtError("RATE_LIMIT", "The shared artwork cache has reached today's limit for new games. Cached games still load; try again tomorrow.", 3600);
      }

      // Refresh a stale hit by id: one call cheaper and keeps the key mapping.
      const fetchSrc: Source = stale ? { kind: "sgdb", id: stale.game.sgdbId, steamAppId: stale.game.steamAppId } : src;
      const got = await fetchFromSgdb(fetchSrc);
      const indexKeys = key.startsWith("sgdb:") ? [] : [key];

      if (!got && stale) {
        // Game vanished from SteamGridDB: keep what we have and bump fetched_at
        // so we don't re-ask on every request for the next 30 days.
        const { fetchedAt: _old, ...keep } = stale.game;
        await db.store(keep, indexKeys, null, key);
        return toData({ ...keep, fetchedAt: new Date(now()).toISOString() }, stale.candidates, "cache", false);
      }
      if (!got) {
        if (indexKeys.length) await db.storeMiss(key, key);
        else await db.release(key);
        throw notFound();
      }

      const row: Omit<StoredGame, "fetchedAt"> = {
        sgdbId: got.game.id,
        name: got.game.name,
        steamAppId: got.steamAppId,
        info: { releaseDate: got.game.releaseDate, types: got.game.types, verified: got.game.verified },
        assets: got.assets,
      };
      await db.store(row, indexKeys, got.candidates, key);
      const fetchedAt = new Date(now()).toISOString();
      return toData({ ...row, fetchedAt }, got.candidates ?? stale?.candidates ?? [], "sgdb", false);
    } catch (err) {
      await db.release(key).catch(() => {});
      // Refresh failed (SteamGridDB down / rate limited): old art beats no art.
      if (stale) return serveStale(err instanceof ArtError ? err.code : "error");
      throw err;
    }
  }

  /** One SteamGridDB page for the picker, cached per (game, kind, page). */
  async function lookupPage(sgdbId: number, kind: AssetKind, page: number, uid: string): Promise<PageData> {
    // The game row must exist first (art_pages references it); usually a cache hit.
    const base = await lookupKey(`sgdb:${sgdbId}`, { kind: "sgdb", id: sgdbId, steamAppId: null }, uid);
    const game = { id: base.game.id, name: base.game.name };
    const out = (p: StoredPage, source: "cache" | "sgdb", stale: boolean): PageData => ({
      game,
      kind,
      page,
      items: p.items,
      total: p.items.length,
      hasMore: p.hasMore,
      source,
      stale,
      fetchedAt: p.fetchedAt,
    });

    const cached = await db.getPage(sgdbId, kind, page);
    if (cached && isFresh(cached.fetchedAt, FRESH_MS)) return out(cached, "cache", false);

    const key = `page:${sgdbId}:${kind}:${page}`;
    if (!(await db.claim(key, CLAIM_TTL_S))) {
      const deadline = now() + waitMs;
      while (now() < deadline) {
        await sleep(pollMs);
        const p = await db.getPage(sgdbId, kind, page);
        if (p && isFresh(p.fetchedAt, FRESH_MS)) return out(p, "cache", false);
      }
      if (cached) return out(cached, "cache", true);
      throw new ArtError("BUSY", "This page is being fetched by another request; retry in a few seconds", 5);
    }

    try {
      const verdict = await db.rateCheck(uid, hourLimit, dailyCap);
      if (verdict !== "ok") {
        await db.release(key);
        if (cached) return out(cached, "cache", true);
        throw verdict === "user"
          ? new ArtError("RATE_LIMIT", `Artwork lookup limit reached (${hourLimit} new requests per hour). Cached pages still load; try again later.`, 900)
          : new ArtError("RATE_LIMIT", "The shared artwork cache has reached today's limit. Cached pages still load; try again tomorrow.", 3600);
      }
      let raw: Raw[] = [];
      try {
        raw = ((await sgdbGet(`/${kind}/game/${sgdbId}`, { ...KIND_PARAMS[kind], limit: String(PAGE_SIZE), page: String(page) })) as Raw[]) || [];
      } catch (err) {
        if (!(err instanceof ArtError && err.code === "NOT_FOUND")) throw err;
      }
      // SteamGridDB's own order (community favourites first, like Hydra), minus unsafe items.
      const items = raw.filter((a: Raw) => !a.nsfw && !a.humor && !a.epilepsy).map(normalizeAsset);
      const hasMore = raw.length >= PAGE_SIZE && page < MAX_PAGE;
      await db.storePage(sgdbId, kind, page, items, hasMore, key);
      return out({ items, hasMore, fetchedAt: new Date(now()).toISOString() }, "sgdb", false);
    } catch (err) {
      await db.release(key).catch(() => {});
      if (cached) return out(cached, "cache", true);
      throw err;
    }
  }

  async function lookup(input: LookupInput, uid: string): Promise<LookupData | PageData> {
    if (input.sgdbId && input.kind) return lookupPage(input.sgdbId, input.kind, input.page ?? 0, uid);
    if (input.sgdbId) {
      return lookupKey(`sgdb:${input.sgdbId}`, { kind: "sgdb", id: input.sgdbId, steamAppId: input.steamAppId ?? null }, uid);
    }
    if (input.steamAppId) {
      try {
        return await lookupKey(`steam:${input.steamAppId}`, { kind: "steam", appId: input.steamAppId }, uid);
      } catch (err) {
        // Same fallback as the desktop's sgdb:resolve: Steam id unknown -> search by name.
        if (!(err instanceof ArtError && err.code === "NOT_FOUND" && input.term)) throw err;
      }
    }
    return lookupKey(`term:${input.term}`, { kind: "term", term: input.term! }, uid);
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (req.method !== "POST") throw new ArtError("BAD_REQUEST", "Use POST with a JSON body");

      const auth = req.headers.get("authorization") || "";
      const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
      const uid = token ? await deps.verifyUser(token).catch(() => null) : null;
      if (!uid) throw new ArtError("UNAUTHENTICATED", "Sign in first (anonymous sign-in is fine) and send the user's access token");

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        throw new ArtError("BAD_REQUEST", "Body must be JSON");
      }
      const data = await lookup(parseInput(body), uid);
      return json(200, { ok: true, data });
    } catch (err) {
      if (err instanceof ArtError) return errorResponse(err);
      log("art-lookup: unexpected error", String((err as Error)?.stack || err));
      return errorResponse(new ArtError("SERVER", "Unexpected server error"));
    }
  };
}
