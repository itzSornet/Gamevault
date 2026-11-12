/* art-lookup — GameVault's shared SteamGridDB artwork cache (milestone M2).
 *
 * POST /functions/v1/art-lookup
 *   Authorization: Bearer <user access token>   (anonymous sign-in is fine;
 *                                                the bare anon key is refused)
 *   apikey: <project anon/publishable key>
 *   Body: { steamAppId?: number, sgdbId?: number, term?: string }
 *
 * Resolution order (mirrors the desktop's sgdb:resolve):
 *   sgdbId -> that game.  Else steamAppId -> /games/steam/{id}; if SteamGridDB
 *   has no such Steam game and `term` was also sent, fall back to term.
 *   term -> /search/autocomplete/{term}; exact (case-insensitive) name match
 *   wins, else SteamGridDB's first hit. All hits come back as `candidates` so
 *   the client can run its own Fuzzy.bestMatch and re-ask with { sgdbId }.
 *
 * Response — success (HTTP 200):
 *   {
 *     ok: true,
 *     data: {
 *       game: { id, name, releaseDate, types, verified, steamAppId },
 *                          // = normalizeGame() from src/backend/sgdb.js, + steamAppId
 *       top: { cover, hero, logo, icon },
 *                          // = sgdb.topOf('grids'|'heroes'|'logos'|'icons', id): Asset | null
 *       assets: { grids, heroes, logos, icons },
 *                          // each = sgdb.assets(kind, id): { items: Asset[], total, hasMore }
 *                          // but items capped at 8 (ranked best first)
 *       candidates: Game[],  // autocomplete hits (term lookups), else []
 *       source: 'cache' | 'sgdb',
 *       stale: boolean,      // true = older than 30 days and refresh failed / was rate limited
 *       fetchedAt: string,   // ISO time the metadata was fetched from SteamGridDB
 *     }
 *   }
 *   Asset = normalizeAsset() from src/backend/sgdb.js:
 *     { id, url, thumb, width, height, style, nsfw, humor, epilepsy, score, upvotes, mime }
 *     (nsfw/humor/epilepsy are always false: those are filtered out, as on desktop)
 *
 * Response — failure: { ok: false, error: { code, message } }, same envelope as
 * the desktop's sgdbWrap(), with an HTTP status:
 *   400 BAD_REQUEST  401 UNAUTHENTICATED  404 NOT_FOUND (cached for 7 days)
 *   429 RATE_LIMIT   (per user: 60 new games/hour; global: ART_DAILY_CAP per
 *                     24 h; or SteamGridDB itself throttling) + Retry-After
 *   503 BUSY  502 NETWORK  500 SERVER
 *
 * Picker paging ("show more"): body { sgdbId, kind: 'grids'|'heroes'|'logos'|'icons', page: 0..49 }
 *   -> { ok: true, data: { game: { id, name }, kind, page, items: Asset[], total, hasMore,
 *                          source, stale, fetchedAt } }
 *   items/total/hasMore match sgdb.assets(kind, id, { page }). Up to 50 items per
 *   page in SteamGridDB's own order (not re-ranked), nsfw/humor/epilepsy removed.
 *   Each page is cached on first request and counts as one miss.
 *
 * Title search: body { search: string }
 *   -> { ok: true, data: { term, candidates: Game[] (max 10), source, stale, fetchedAt } }
 *   One SteamGridDB autocomplete call, cached per term for 7 days. Counted in
 *   its own bucket (ART_SEARCH_HOURLY_LIMIT per user, default 300;
 *   ART_SEARCH_DAILY_CAP overall, default 20000), not the game lookups' one.
 *
 * SteamGridDB is queried with nsfw=false, humor=false, png/jpeg/webp only (no
 * GIFs), covers limited to 600x900 / 342x482 / 660x930 (top-8 falls back to any
 * size if a game has none).
 *
 * Cache hits never count toward the limits and never call SteamGridDB.
 * Clients may also read art_index / art_games directly over REST with the anon
 * key (public SELECT) and call this function only on a miss.
 *
 * Env (Dashboard -> Edge Functions -> Secrets): SGDB_KEY (required),
 * ART_DAILY_CAP (optional, default 2000), ART_HOURLY_LIMIT (optional, default
 * 60). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
 */
import { createClient } from "@supabase/supabase-js";
import {
  type ArtDb,
  createHandler,
  type Game,
  type IndexRow,
  type RateVerdict,
  type StoredGame,
  type StoredPage,
  type StoredSearch,
} from "./lib.ts";

function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback;
  if (v == null || v === "") throw new Error(`Missing env ${name}`);
  return v;
}

function intEnv(name: string, fallback: number): number {
  const n = Number(Deno.env.get(name));
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

const db: ArtDb = {
  async getIndex(key) {
    const row = check(
      await supabase.from("art_index").select("sgdb_id, candidates, created_at").eq("key", key).maybeSingle(),
      "art_index read",
    );
    if (!row) return null;
    return { sgdbId: row.sgdb_id, candidates: row.candidates as Game[] | null, createdAt: row.created_at } as IndexRow;
  },
  async getGame(sgdbId) {
    const row = check(
      await supabase.from("art_games").select("sgdb_id, name, steam_appid, info, assets, fetched_at").eq("sgdb_id", sgdbId)
        .maybeSingle(),
      "art_games read",
    );
    if (!row) return null;
    return {
      sgdbId: Number(row.sgdb_id),
      name: row.name,
      steamAppId: row.steam_appid,
      info: row.info,
      assets: row.assets,
      fetchedAt: row.fetched_at,
    } as StoredGame;
  },
  async claim(key, ttlSeconds) {
    return check(await supabase.rpc("art_claim", { p_key: key, p_ttl_seconds: ttlSeconds }), "art_claim") === true;
  },
  async release(key) {
    check(await supabase.rpc("art_release", { p_key: key }), "art_release");
  },
  async store(game, keys, candidates, claimKey) {
    check(
      await supabase.rpc("art_store", {
        p_sgdb_id: game.sgdbId,
        p_name: game.name,
        p_steam_appid: game.steamAppId,
        p_info: game.info,
        p_assets: game.assets,
        p_keys: keys,
        p_candidates: candidates,
        p_claim_key: claimKey,
      }),
      "art_store",
    );
  },
  async storeMiss(key, claimKey) {
    check(await supabase.rpc("art_store_miss", { p_key: key, p_claim_key: claimKey }), "art_store_miss");
  },
  async getPage(sgdbId, kind, page) {
    const row = check(
      await supabase.from("art_pages").select("items, has_more, fetched_at").eq("sgdb_id", sgdbId).eq("kind", kind)
        .eq("page", page).maybeSingle(),
      "art_pages read",
    );
    if (!row) return null;
    return { items: row.items, hasMore: row.has_more, fetchedAt: row.fetched_at } as StoredPage;
  },
  async storePage(sgdbId, kind, page, items, hasMore, claimKey) {
    check(
      await supabase.rpc("art_store_page", {
        p_sgdb_id: sgdbId,
        p_kind: kind,
        p_page: page,
        p_items: items,
        p_has_more: hasMore,
        p_claim_key: claimKey,
      }),
      "art_store_page",
    );
  },
  async rateCheck(uid, hourLimit, dailyCap) {
    return check(
      await supabase.rpc("art_rate_check", { p_uid: uid, p_hour_limit: hourLimit, p_daily_cap: dailyCap }),
      "art_rate_check",
    ) as RateVerdict;
  },
  async getSearch(term) {
    const row = check(
      await supabase.from("art_searches").select("candidates, fetched_at").eq("term", term).maybeSingle(),
      "art_searches read",
    );
    if (!row) return null;
    return { candidates: row.candidates as Game[], fetchedAt: row.fetched_at } as StoredSearch;
  },
  async storeSearch(term, candidates) {
    check(
      await supabase.from("art_searches").upsert({ term, candidates, fetched_at: new Date().toISOString() }),
      "art_searches write",
    );
  },
  async searchRateCheck(uid, hourLimit, dailyCap) {
    return check(
      await supabase.rpc("art_search_rate_check", { p_uid: uid, p_hour_limit: hourLimit, p_daily_cap: dailyCap }),
      "art_search_rate_check",
    ) as RateVerdict;
  },
};

const handler = createHandler({
  db,
  // Not required at boot: cache hits work without it; misses return SERVER.
  sgdbKey: Deno.env.get("SGDB_KEY") ?? "",
  hourLimit: intEnv("ART_HOURLY_LIMIT", 60),
  dailyCap: intEnv("ART_DAILY_CAP", 2000),
  searchHourLimit: intEnv("ART_SEARCH_HOURLY_LIMIT", 300),
  searchDailyCap: intEnv("ART_SEARCH_DAILY_CAP", 20000),
  // Ask Supabase Auth who the token belongs to. Refuses the anon key itself
  // (no user) and expired/forged tokens; accepts anonymous users.
  async verifyUser(token) {
    const { data, error } = await supabase.auth.getUser(token);
    return error || !data?.user?.id ? null : data.user.id;
  },
});

Deno.serve(handler);
