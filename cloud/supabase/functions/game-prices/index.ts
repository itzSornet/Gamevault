/* game-prices: wishlist prices from IsThereAnyDeal, through GameVault Cloud.
 *
 * POST /functions/v1/game-prices
 *   Authorization: Bearer <user access token>   (anonymous sign-in is fine;
 *                                                the bare anon key is refused)
 *   apikey: <project anon/publishable key>
 *   Body: { steamAppIds?: number[], itadIds?: string[] (1..50 together),
 *           country?: "US" (ISO 3166-1 alpha-2) }
 *     or: { titles: string[] (1..20) }   -> which game each title is
 *
 * Response (HTTP 200):
 *   { ok: true, data: { country, prices: { [steamAppId | "itad:<id>"]: Price | null }, fetchedAt } }
 *   titles: { ok: true, data: { matches: { [title]: Match | null } } }
 *   Match = { itadId, title, appid: number | null }   // appid = its Steam AppID
 *     Found by ITAD's exact title lookup first, then its search (games only,
 *     same name give or take an edition word). Kept 30 days, misses 1 day.
 *   Price = {
 *     current: Deal | null,              // the cheapest shop right now (picked here, from deals)
 *     deals:   Deal[],                   // every shop selling it, cheapest first
 *     lowest:  { amount, currency } | null,  // lowest price ever, any shop
 *     page:    string,                   // the game on isthereanydeal.com
 *   }
 *   Deal = { shop, amount, regular, cut, currency, url, drm: string[] }
 *   null = IsThereAnyDeal has no such game or no price for it.
 *   Amounts, currencies and links are IsThereAnyDeal's own, unchanged (their
 *   API terms: data must not be altered, affiliate links stay as they are).
 *
 * Failure: { ok: false, error: { code, message } } with 400 BAD_REQUEST,
 *   401 UNAUTHENTICATED, 429 RATE_LIMIT (+ Retry-After), 502 NETWORK, 500 SERVER.
 *
 * Caching: each country+game answer is kept PRICE_TTL_HOURS (default 6);
 * Steam AppID -> ITAD id for 30 days. Cache hits never count toward limits.
 * Limits count uncached games: PRICE_HOURLY_LIMIT per user (default 600),
 * PRICE_DAILY_CAP overall (default 40000). IsThereAnyDeal itself allows 1000
 * requests per 5 minutes; one request covers up to 200 games.
 *
 * Env (Dashboard -> Edge Functions -> Secrets): ITAD_KEY (required for
 * misses). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
 */
import { createClient } from "@supabase/supabase-js";

const ITAD = "https://api.isthereanydeal.com";
const STEAM_SHOP = 61;
const DAY = 24 * 3600 * 1000;

function intEnv(name: string, fallback: number): number {
  const n = Number(Deno.env.get(name));
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const ITAD_KEY = Deno.env.get("ITAD_KEY") ?? "";
const TTL = intEnv("PRICE_TTL_HOURS", 6) * 3600 * 1000;
const HOUR_LIMIT = intEnv("PRICE_HOURLY_LIMIT", 600);
const DAILY_CAP = intEnv("PRICE_DAILY_CAP", 40000);

type Money = { amount?: number; currency?: string };
type Deal = {
  shop?: { name?: string };
  price?: Money;
  regular?: Money;
  cut?: number;
  url?: string;
  timestamp?: string;
};
type Found = { itadId: string; title: string; appid: number | null };

// "The Witcher® 3: Wild Hunt" -> "thewitcher3wildhunt"
const norm = (t: string) => String(t || "").toLowerCase().replace(/[\u2122\u00ae\u00a9]/g, "")
  .replace(/&/g, "and").replace(/[^\p{L}\p{N}]+/gu, "");
// words a store adds to the same game
const EDITION = /^(goty|gameoftheyear|definitive|complete|deluxe|ultimate|remastered|enhanced|directorscut|edition|standard|anniversary|premium|gold)+$/;
const sameGame = (a: string, b: string) => {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return long.startsWith(short) && EDITION.test(long.slice(short.length));
};

// "The Witcher 3: Wild Hunt - Game of the Year Edition" -> "The Witcher 3: Wild Hunt"
const stripEdition = (t: string) => t.replace(
  /[\s:\-\u2013\u2014]*[([]?\b(game of the year|goty|definitive|complete|deluxe|ultimate|remastered|enhanced|director'?s cut|anniversary|gold|premium|standard)\b( edition)?[)\]]?\s*$/i,
  "",
).trim();

async function itadGet(path: string, query: Record<string, string>) {
  const qs = new URLSearchParams({ key: ITAD_KEY, ...query });
  let res: Response;
  try {
    res = await fetch(`${ITAD}${path}?${qs}`, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new Fail("NETWORK", `IsThereAnyDeal unreachable: ${(err as Error).message}`, 502);
  }
  if (res.status === 429) {
    throw new Fail("RATE_LIMIT", "IsThereAnyDeal is busy; try again shortly", 429, Number(res.headers.get("Retry-After")) || 60);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Fail("NETWORK", `IsThereAnyDeal error ${res.status}`, 502);
  return await res.json();
}

/** Titles -> ITAD game + Steam AppID, from the table first, then ITAD. */
async function matchTitles(titles: string[]): Promise<Record<string, Found | null>> {
  const out: Record<string, Found | null> = {};
  const keys = new Map(titles.map((t) => [t, norm(t)]));
  const { data: rows, error } = await supabase.from("price_titles").select("norm, itad_id, title, appid, fetched_at")
    .in("norm", [...new Set(keys.values())]);
  if (error) throw new Fail("SERVER", `price_titles read: ${error.message}`, 500);
  const known = new Map<string, Found | null>();
  for (const r of rows ?? []) {
    const ttl = r.itad_id ? 30 * DAY : DAY;
    if (Date.now() - Date.parse(r.fetched_at) < ttl) {
      known.set(r.norm, r.itad_id ? { itadId: r.itad_id, title: r.title ?? "", appid: r.appid ?? null } : null);
    }
  }
  const todo = titles.filter((t) => !known.has(keys.get(t)!));
  if (todo.length) {
    // 1) exact lookup of each title and of it without edition words, in one
    //    call (ITAD keeps "GOTY Edition" packs apart from the game itself)
    const names = [...new Set(todo.flatMap((t) => [t, stripEdition(t)]).filter(Boolean))];
    const exact = await itad("/lookup/id/title/v1", names) as Record<string, string | null>;
    const pick = (n: string) => (exact && typeof exact[n] === "string" ? exact[n] : null);
    const cands = new Map<string, string[]>();
    for (const t of todo) cands.set(t, [...new Set([pick(t), pick(stripEdition(t))].filter((x): x is string => !!x))]);
    // 2) none: ITAD's search, games with the same name (edition words aside)
    for (const t of todo.filter((x) => !cands.get(x)!.length)) {
      const list = await itadGet("/games/search/v1", { title: t, results: "10" }) as { id: string; title: string; type: string }[] | null;
      const hits = (Array.isArray(list) ? list : []).filter((g) => g.type === "game" && sameGame(g.title, t));
      cands.set(t, hits.slice(0, 3).map((g) => g.id));
    }
    // 3) each candidate's Steam AppID; the one on Steam wins, else the first
    const now = new Date().toISOString();
    const upserts: Record<string, unknown>[] = [];
    for (const t of todo) {
      let found: Found | null = null;
      for (const gid of cands.get(t)!) {
        const info = await itadGet("/games/info/v2", { id: gid }) as { title?: string; appid?: number } | null;
        const f = { itadId: gid, title: String(info?.title ?? t), appid: Number(info?.appid) > 0 ? Number(info!.appid) : null };
        if (!found) found = f;
        if (f.appid) { found = f; break; }
      }
      known.set(keys.get(t)!, found);
      upserts.push({ norm: keys.get(t), itad_id: found?.itadId ?? null, title: found?.title ?? null, appid: found?.appid ?? null, fetched_at: now });
    }
    const { error: e2 } = await supabase.from("price_titles").upsert(upserts);
    if (e2) console.warn("price_titles write:", e2.message);
  }
  for (const t of titles) out[t] = known.get(keys.get(t)!) ?? null;
  return out;
}

type GamePrices = { id: string; historyLow?: { all?: Money | null } | null; deals?: (Deal & { drm?: { name?: string }[] })[] };

class Fail extends Error {
  constructor(public code: string, message: string, public status: number, public retry = 0) {
    super(message);
  }
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });

function deal(d: (Deal & { drm?: { name?: string }[] }) | null | undefined) {
  if (!d || !d.price || typeof d.price.amount !== "number") return null;
  return {
    shop: String(d.shop?.name ?? ""),
    amount: d.price.amount,
    regular: typeof d.regular?.amount === "number" ? d.regular.amount : d.price.amount,
    cut: Number(d.cut) || 0,
    currency: String(d.price.currency ?? ""),
    url: String(d.url ?? ""),
    drm: Array.isArray(d.drm) ? d.drm.map((x) => String(x?.name ?? "")).filter(Boolean) : [],
  };
}

async function itad(path: string, body: unknown, query: Record<string, string> = {}) {
  const qs = new URLSearchParams({ key: ITAD_KEY, ...query });
  let res: Response;
  try {
    res = await fetch(`${ITAD}${path}?${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Fail("NETWORK", `IsThereAnyDeal unreachable: ${(err as Error).message}`, 502);
  }
  if (res.status === 429) {
    throw new Fail("RATE_LIMIT", "IsThereAnyDeal is busy; try again shortly", 429, Number(res.headers.get("Retry-After")) || 60);
  }
  if (!res.ok) throw new Fail("NETWORK", `IsThereAnyDeal error ${res.status}`, 502);
  return await res.json();
}

/** Steam AppIDs -> ITAD ids, from the table first, then one ITAD lookup. */
async function itadIds(appIds: number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const { data: rows, error } = await supabase.from("price_ids").select("steam_appid, itad_id, fetched_at")
    .in("steam_appid", appIds);
  if (error) throw new Fail("SERVER", `price_ids read: ${error.message}`, 500);
  for (const r of rows ?? []) {
    // unknown games are asked again after a day, known ones after 30
    const ttl = r.itad_id ? 30 * DAY : DAY;
    if (Date.now() - Date.parse(r.fetched_at) < ttl) out.set(r.steam_appid, r.itad_id);
  }
  const missing = appIds.filter((id) => !out.has(id));
  if (missing.length) {
    const found = await itad(`/lookup/id/shop/${STEAM_SHOP}/v1`, missing.map((id) => `app/${id}`)) as Record<string, string | null>;
    const now = new Date().toISOString();
    const upserts = missing.map((id) => {
      const v = found && typeof found[`app/${id}`] === "string" ? found[`app/${id}`] : null;
      out.set(id, v);
      return { steam_appid: id, itad_id: v, fetched_at: now };
    });
    const { error: e2 } = await supabase.from("price_ids").upsert(upserts);
    if (e2) console.warn("price_ids write:", e2.message);
  }
  return out;
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") throw new Fail("BAD_REQUEST", "Use POST", 405);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who, error: authErr } = await supabase.auth.getUser(token);
  const uid = !authErr && who?.user?.id;
  if (!uid) throw new Fail("UNAUTHENTICATED", "Sign in first (anonymous is fine)", 401);

  const body = await req.json().catch(() => null) as { steamAppIds?: unknown; itadIds?: unknown; titles?: unknown; country?: unknown } | null;

  if (Array.isArray(body?.titles)) {
    const titles = [...new Set(body!.titles.map((t) => String(t ?? "").trim().slice(0, 200)).filter((t) => norm(t)))];
    if (!titles.length || titles.length > 20) throw new Fail("BAD_REQUEST", "Send 1 to 20 titles", 400);
    if (!ITAD_KEY) throw new Fail("SERVER", "Prices are not set up on the server yet", 500);
    const { data: verdict, error: rateErr } = await supabase.rpc("price_rate_check", {
      p_uid: uid, p_n: titles.length, p_hour_limit: HOUR_LIMIT, p_daily_cap: DAILY_CAP,
    });
    if (rateErr) throw new Fail("SERVER", `price_rate_check: ${rateErr.message}`, 500);
    if (verdict !== "ok") throw new Fail("RATE_LIMIT", "Lookup limit reached; try again later", 429, 900);
    return json({ ok: true, data: { matches: await matchTitles(titles) } });
  }

  const appIds = Array.isArray(body?.steamAppIds)
    ? [...new Set(body!.steamAppIds.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))]
    : [];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const gidsAsked = Array.isArray(body?.itadIds)
    ? [...new Set(body!.itadIds.map((x) => String(x ?? "").toLowerCase()).filter((x) => UUID.test(x)))]
    : [];
  // one list of wanted games: Steam AppIDs as numbers, ITAD ids as "itad:<id>"
  const ids: (number | string)[] = [...appIds, ...gidsAsked.map((g) => `itad:${g}`)];
  if (!ids.length || ids.length > 50) throw new Fail("BAD_REQUEST", "Send 1 to 50 steamAppIds or itadIds", 400);
  const country = typeof body?.country === "string" && /^[A-Za-z]{2}$/.test(body.country) ? body.country.toUpperCase() : "US";
  const key = (id: number | string) => `${country}:${id}`;

  const prices: Record<string, unknown> = {};
  const { data: cached, error } = await supabase.from("price_cache").select("key, data, fetched_at")
    .in("key", ids.map(key));
  if (error) throw new Fail("SERVER", `price_cache read: ${error.message}`, 500);
  const old = new Map<string, unknown>();
  for (const r of cached ?? []) {
    old.set(r.key, r.data);
    // answers from before every shop was listed are refetched
    const full = r.data === null || (r.data && Array.isArray((r.data as { deals?: unknown }).deals));
    if (full && Date.now() - Date.parse(r.fetched_at) < TTL) prices[r.key.slice(3)] = r.data;
  }
  const misses = ids.filter((id) => !(String(id) in prices));
  const serveOld = () => {
    for (const id of misses) if (old.has(key(id))) prices[id] = old.get(key(id));
  };

  if (misses.length) {
    if (!ITAD_KEY) {
      serveOld();
      if (!Object.keys(prices).length) throw new Fail("SERVER", "Prices are not set up on the server yet", 500);
    } else {
      const { data: verdict, error: rateErr } = await supabase.rpc("price_rate_check", {
        p_uid: uid, p_n: misses.length, p_hour_limit: HOUR_LIMIT, p_daily_cap: DAILY_CAP,
      });
      if (rateErr) throw new Fail("SERVER", `price_rate_check: ${rateErr.message}`, 500);
      if (verdict !== "ok") {
        serveOld();
        if (!Object.keys(prices).length) {
          throw verdict === "user"
            ? new Fail("RATE_LIMIT", "Price lookup limit reached; try again later", 429, 900)
            : new Fail("RATE_LIMIT", "Prices have reached today's limit; try again tomorrow", 429, 3600);
        }
      } else {
        try {
          const map = new Map<number | string, string | null>();
          const missApps = misses.filter((id): id is number => typeof id === "number");
          if (missApps.length) for (const [k, v] of await itadIds(missApps)) map.set(k, v);
          for (const id of misses) if (typeof id === "string") map.set(id, id.slice(5));
          const gids = [...new Set([...map.values()].filter((v): v is string => !!v))];
          const byGid = new Map<string, GamePrices>();
          if (gids.length) {
            // every shop's price; the cheapest is picked here (ITAD's own
            // "best price" overview once said Blizzard $49.99 for The Witcher 3)
            const list = await itad("/games/prices/v3", gids, { country }) as GamePrices[];
            for (const p of Array.isArray(list) ? list : []) byGid.set(p.id, p);
          }
          const now = new Date().toISOString();
          const rows = misses.map((id) => {
            const gid = map.get(id);
            const p = gid ? byGid.get(gid) : null;
            const deals = (p?.deals ?? []).map(deal).filter((d): d is NonNullable<ReturnType<typeof deal>> => !!d)
              .sort((a, b) => a.amount - b.amount);
            const low = p?.historyLow?.all;
            const entry = p && (deals.length || low)
              ? {
                current: deals[0] ?? null,
                deals,
                lowest: low && typeof low.amount === "number" ? { amount: low.amount, currency: String(low.currency ?? "") } : null,
                page: `https://isthereanydeal.com/game/id:${gid}/`,
              }
              : null;
            prices[id] = entry;
            return { key: key(id), data: entry, fetched_at: now };
          });
          const { error: e3 } = await supabase.from("price_cache").upsert(rows);
          if (e3) console.warn("price_cache write:", e3.message);
        } catch (err) {
          // ITAD down or busy: old prices beat none
          serveOld();
          if (!Object.keys(prices).length) throw err;
        }
      }
    }
  }
  return json({ ok: true, data: { country, prices, fetchedAt: new Date().toISOString() } });
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    const f = err instanceof Fail ? err : new Fail("SERVER", (err as Error).message || "Server error", 500);
    if (!(err instanceof Fail)) console.error(err);
    return json({ ok: false, error: { code: f.code, message: f.message } }, f.status,
      f.retry ? { "Retry-After": String(f.retry) } : {});
  }
});
