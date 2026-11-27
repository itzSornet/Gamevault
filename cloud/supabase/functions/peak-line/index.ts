/* peak-line: what critics said about a game, for its Peak scroll and its
 * page. Fetched once per game and shared: everyone with the game reads the
 * same score and line.
 *
 * OpenCritic comes first: its Top Critic Average (all platforms) and a line
 * from a real review, picked by DeepSeek as the one that fits someone who
 * already loves the game ("... - IGN"). When no review line fits, or the
 * game isn't on OpenCritic, DeepSeek writes the line itself from the store
 * facts. When OpenCritic can't be asked (its daily limit, no key, down), the
 * line DeepSeek writes is a stand-in: kept for a day, then OpenCritic is
 * asked again and its answer replaces it.
 *
 * POST /functions/v1/peak-line
 *   Authorization: Bearer <user access token>   (anonymous sign-in is fine)
 *   apikey: <project anon/publishable key>
 *   Body: { games: [{ steamAppId?: number, itadId?: string }] (1..10) }
 *
 * Response (HTTP 200):
 *   { ok: true, data: { lines: { ["steam:<appid>" | "itad:<id>"]:
 *       { line: string | null, by: string | null, score: number | null, final: boolean } } } }
 *   by = the outlet a quoted line is from (null: written by DeepSeek);
 *   score = OpenCritic's Top Critic Average (null: none);
 *   final = false: a stand-in, asked again after a day.
 *   A game left out = no answer this time (no DeepSeek key yet, today's cap).
 *
 * The facts come from here, never from the app (Steam's store page,
 * IsThereAnyDeal, OpenCritic), so no one can plant a line for everyone else.
 * Nothing about the user is sent to DeepSeek or OpenCritic.
 *
 * Failure: { ok: false, error: { code, message } } with 400 BAD_REQUEST,
 *   401 UNAUTHENTICATED, 429 RATE_LIMIT (+ Retry-After), 500 SERVER.
 *
 * No limit per user. PEAK_DAILY_CAP (default 3000) caps new lines a day
 * overall, so DeepSeek can never cost more than about $1 a day.
 *
 * Env (Dashboard -> Edge Functions -> Secrets): DEEPSEEK_KEY (required for
 * new lines), OPENCRITIC_KEY (RapidAPI key for OpenCritic; optional),
 * ITAD_KEY (optional: tags). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
 * injected by Supabase.
 */
import { createClient } from "@supabase/supabase-js";

const DAY = 24 * 3600 * 1000;
const MODEL = "deepseek-flash";
const OC_HOST = "opencritic-api.p.rapidapi.com";

function intEnv(name: string, fallback: number): number {
  const n = Number(Deno.env.get(name));
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const DEEPSEEK_KEY = Deno.env.get("DEEPSEEK_KEY") ?? "";
const OPENCRITIC_KEY = Deno.env.get("OPENCRITIC_KEY") ?? "";
const ITAD_KEY = Deno.env.get("ITAD_KEY") ?? "";
const DAILY_CAP = intEnv("PEAK_DAILY_CAP", 3000);

class Fail extends Error {
  constructor(public code: string, message: string, public status: number, public retry = 0) {
    super(message);
  }
}
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });

// The rules. Kept word for word the same on every call, so DeepSeek bills
// them at its cached-input price.
const RULES = `You write one line for a keepsake card about a video game. The reader has already finished this game and loves it. Rules:
1. One sentence, 12 to 25 words.
2. Speak to someone who has played it: warm, a little nostalgic. Never sell it or describe it to a newcomer.
3. Never use these words: epic, award, acclaimed, masterpiece, must-play, experience, journey, immersive, stunning, breathtaking, unforgettable, ultimate, iconic, legendary, groundbreaking, adventure awaits.
4. No spoilers: no endings, twists, deaths, final bosses or late-game events.
5. Use only the facts given. Never invent names, places, numbers or features. When unsure, stay general.
6. Do not name the game, its developer or publisher, and do not mention years, prices, awards, scores or platforms.
7. Plain English. No emoji, no exclamation marks, no quotation marks, no hashtags.
8. Speak to the reader as you; never write I, me, my or we.
9. Reply with the sentence only.`;

const PICK = `You choose a line from real critics' reviews of a video game for a keepsake card. The reader has already finished the game and loves it. Choose the one quote that:
- says something true and specific about how the game plays or feels,
- still reads well on its own, out of its review,
- is not a buying tip or a verdict for newcomers (no "buy it", "a must", "worth your money", "if you like X"),
- has no spoilers: no endings, twists, deaths or late-game events,
- does not complain about the game.
Reply with the quote's number only. Reply 0 when no quote fits all of these.`;

const BANNED = /\b(epic|award|acclaimed|masterpiece|must-?play|experience|journey|immersive|stunning|breathtaking|unforgettable|ultimate|iconic|legendary|groundbreaking)\b/i;
const norm = (t: string) => String(t || "").toLowerCase().replace(/[™®©]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
const text = (h: string) => String(h || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

type Facts = { title: string; developer: string[]; publisher: string[]; genres: string[]; tags: string[]; about: string };
type Quote = { text: string; by: string };
type Critics = { status: "ok" | "none" | "later"; id?: number; score?: number | null; quotes?: Quote[] };
type Row = { key: string; line: string | null; by: string | null; score: number | null; oc_id: number | null; final: boolean; model: string | null; created_at: string };

async function getJson(url: string, init: RequestInit = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function itadTags(gid: string | null): Promise<{ title?: string; tags: string[]; developer: string[] }> {
  if (!gid || !ITAD_KEY) return { tags: [], developer: [] };
  const info = await getJson(`https://api.isthereanydeal.com/games/info/v2?${new URLSearchParams({ key: ITAD_KEY, id: gid })}`);
  return {
    title: info?.title,
    tags: Array.isArray(info?.tags) ? info.tags.map(String).slice(0, 8) : [],
    developer: Array.isArray(info?.developers) ? info.developers.map((d: { name?: string }) => String(d?.name ?? "")).filter(Boolean) : [],
  };
}

/** What is known about the game, from Steam and IsThereAnyDeal; null = nothing. */
async function factsFor(key: string): Promise<Facts | null> {
  if (key.startsWith("steam:")) {
    const appid = key.slice(6);
    const body = await getJson(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`);
    const d = body?.[appid]?.success ? body[appid].data : null;
    if (!d) return null;
    const { data: row } = await supabase.from("price_ids").select("itad_id").eq("steam_appid", Number(appid)).maybeSingle();
    const it = await itadTags(row?.itad_id ?? null);
    return {
      title: String(d.name ?? ""),
      developer: Array.isArray(d.developers) ? d.developers.map(String) : [],
      publisher: Array.isArray(d.publishers) ? d.publishers.map(String) : [],
      genres: Array.isArray(d.genres) ? d.genres.map((g: { description?: string }) => String(g?.description ?? "")).filter(Boolean) : [],
      tags: it.tags,
      // the store's own words, as background only (the rules forbid its pitch)
      about: text(d.about_the_game || d.short_description || "").slice(0, 1200),
    };
  }
  const it = await itadTags(key.slice(5));
  if (!it.title) return null;
  return { title: it.title, developer: it.developer, publisher: [], genres: [], tags: it.tags, about: "" };
}

// OpenCritic takes 4 requests a second: calls go one after another, 300ms
// apart, and one that is still refused waits a second and tries once more
let ocTurn: Promise<void> = Promise.resolve();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function ocSlot(): Promise<void> {
  const mine = ocTurn.then(() => sleep(300));
  ocTurn = mine.catch(() => {});
  return ocTurn.then(() => {});
}

/** OpenCritic, through RapidAPI. later = can't ask now (daily limit, down). */
async function oc(path: string, again = true): Promise<{ later: boolean; body: unknown }> {
  try {
    await ocSlot();
    const res = await fetch(`https://${OC_HOST}${path}`, {
      headers: { "x-rapidapi-host": OC_HOST, "x-rapidapi-key": OPENCRITIC_KEY },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429 && again) {
      await res.body?.cancel();
      await sleep(1100);
      return oc(path, false);
    }
    if (res.status === 404) return { later: false, body: null };
    if (!res.ok) {
      console.warn("opencritic", path.split("?")[0], res.status, (await res.text().catch(() => "")).slice(0, 160));
      return { later: true, body: null };
    }
    return { later: false, body: await res.json() };
  } catch (err) {
    console.warn("opencritic", (err as Error).message);
    return { later: true, body: null };
  }
}

// "The Witcher 3: Wild Hunt - Game of the Year Edition" -> "thewitcher3wildhunt"
const EDITION = /\s*[-:–—]?\s*(game of the year|goty|complete|definitive|deluxe|ultimate|enhanced|director'?s cut|remastered|anniversary|gold|premium|standard)( edition)?\s*$/i;
const plain = (t: string) => norm(String(t || "").replace(EDITION, ""));

/** The game's OpenCritic score and its review lines. */
async function critics(title: string, knownId: number | null): Promise<Critics> {
  if (!OPENCRITIC_KEY) return { status: "later" };
  let id = knownId;
  if (!id) {
    const found = await oc(`/game/search?${new URLSearchParams({ criteria: title.replace(/[™®©]/g, "") })}`);
    if (found.later) return { status: "later" };
    const list = Array.isArray(found.body) ? found.body as { id?: number; name?: string; dist?: number }[] : [];
    // the same name, with or without an edition ("The Witcher 3: Wild Hunt",
    // "... Complete Edition"): the oldest entry, the original release; else a
    // near miss
    const want = plain(title);
    const same = list.filter((x) => x && Number(x.id) > 0 && plain(String(x.name ?? "")) === want)
      .sort((a, b) => Number(a.id) - Number(b.id));
    const hit = same[0] ?? list.find((x) => x && typeof x.dist === "number" && x.dist < 0.1);
    if (!hit || !Number.isSafeInteger(Number(hit.id))) return { status: "none" };
    id = Number(hit.id);
  }
  const [game, reviews] = await Promise.all([oc(`/game/${id}`), oc(`/reviews/game/${id}`)]);
  if (game.later || reviews.later) return { status: "later", id };
  const g = (game.body ?? {}) as { topCriticScore?: number };
  const score = Number(g.topCriticScore) > 0 ? Math.round(Number(g.topCriticScore)) : null;
  const seen = new Set<string>();
  const quotes: Quote[] = [];
  for (const r of Array.isArray(reviews.body) ? reviews.body as Record<string, unknown>[] : []) {
    const outlet = (r?.Outlet ?? r?.outlet) as { name?: string } | undefined;
    const by = String(outlet?.name ?? "").trim();
    const line = text(String(r?.snippet ?? "")).replace(/^["“]+|["”]+$/g, "");
    const lang = String(r?.language ?? "en").toLowerCase();
    if (!by || !line || !lang.startsWith("en") || seen.has(line)) continue;
    const n = words(line);
    if (n < 6 || n > 30) continue;   // it has to fit on the Peak paper
    seen.add(line);
    quotes.push({ text: line, by });
  }
  return { status: "ok", id, score, quotes: quotes.slice(0, 15) };
}

/** Why a draft breaks the rules, or "" when it is fine. */
function problem(line: string, f: Facts): string {
  const n = words(line);
  if (n < 8 || n > 30) return "It must be one sentence of 12 to 25 words.";
  if ((line.match(/[.!?](\s|$)/g) || []).length > 1) return "It must be a single sentence.";
  if (/[!#"“”]|\p{Extended_Pictographic}/u.test(line)) return "No exclamation marks, quotation marks, hashtags or emoji.";
  if (BANNED.test(line)) return `Do not use the word "${line.match(BANNED)![0]}".`;
  if (/\b(I|me|my|mine|we|our|us)\b/i.test(line)) return "Speak to the reader as you; never I, me, my or we.";
  const all = `${f.title} ${f.about} ${f.tags.join(" ")} ${f.genres.join(" ")}`;
  for (const num of line.match(/\d+/g) || []) if (!all.includes(num)) return `Do not use the number ${num}; it is not in the facts.`;
  const l = norm(line);
  for (const name of [f.title, ...f.developer, ...f.publisher]) {
    const k = norm(name);
    if (k.length >= 4 && l.includes(k)) return `Do not name ${name}.`;
  }
  return "";
}

/** DeepSeek's reply; throws when DeepSeek can't answer (bad key, down). */
async function deepseek(messages: { role: string; content: string }[]): Promise<string> {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: MODEL, messages, max_tokens: 1500,
      thinking: { type: "enabled" }, reasoning_effort: "low",
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const body = await res.json();
  if (body?.usage) console.log("peak-line usage", JSON.stringify(body.usage));
  const out = body?.choices?.[0]?.message?.content;
  return typeof out === "string" ? out.replace(/\s+/g, " ").trim().replace(/^["'“]+|["'”]+$/g, "") : "";
}

/** The review line that fits, word for word as the critic wrote it; null = none fits. */
async function pick(title: string, quotes: Quote[]): Promise<Quote | null> {
  if (!quotes.length) return null;
  const list = quotes.map((q, i) => `${i + 1}. ${q.text}`).join("\n");
  const reply = await deepseek([{ role: "system", content: PICK }, { role: "user", content: `Game: ${title}\nQuotes:\n${list}` }]);
  const n = Number((reply.match(/\d+/) || [])[0]);
  return n >= 1 && n <= quotes.length ? quotes[n - 1] : null;
}

/** A line DeepSeek wrote that passed the checks, in at most two tries; null when none did. */
async function write(f: Facts): Promise<string | null> {
  const facts = JSON.stringify({ title: f.title, developer: f.developer, genres: f.genres, tags: f.tags, store_text: f.about });
  const messages = [{ role: "system", content: RULES }, { role: "user", content: `Facts:\n${facts}` }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const line = await deepseek(messages);
    if (!line) return null;
    const why = problem(line, f);
    if (!why) return line;
    messages.push({ role: "assistant", content: line }, { role: "user", content: `${why} Write it again, following every rule.` });
  }
  return null;
}

/** One game's row; null = no answer this time (DeepSeek can't be reached). */
async function make(key: string, old: Row | undefined): Promise<Row | null> {
  const f = await factsFor(key);
  const now = new Date().toISOString();
  if (!f) return { key, line: null, by: null, score: null, oc_id: old?.oc_id ?? null, final: true, model: null, created_at: now };
  const c = await critics(f.title, old?.oc_id ?? null);
  try {
    const q = c.status === "ok" ? await pick(f.title, c.quotes ?? []) : null;
    const line = q ? q.text : await write(f);
    return {
      key, line, by: q ? q.by : null, score: c.score ?? null, oc_id: c.id ?? null,
      final: c.status !== "later", model: q ? `opencritic+${MODEL}` : (line ? MODEL : null), created_at: now,
    };
  } catch (err) {
    console.warn("peak-line:", (err as Error).message);
    return null;
  }
}

const out = (r: Row) => ({ line: r.line, by: r.by, score: r.score, final: r.final });

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") throw new Fail("BAD_REQUEST", "Use POST", 405);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who, error: authErr } = await supabase.auth.getUser(token);
  const uid = !authErr && who?.user?.id;
  if (!uid) throw new Fail("UNAUTHENTICATED", "Sign in first (anonymous is fine)", 401);

  const body = await req.json().catch(() => null) as { games?: unknown } | null;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const keys = [...new Set((Array.isArray(body?.games) ? body!.games : []).map((g) => {
    const x = g as { steamAppId?: unknown; itadId?: unknown };
    const n = Number(x?.steamAppId);
    if (Number.isSafeInteger(n) && n > 0) return `steam:${n}`;
    const id = String(x?.itadId ?? "").toLowerCase();
    return UUID.test(id) ? `itad:${id}` : "";
  }).filter(Boolean))];
  if (!keys.length || keys.length > 10) throw new Fail("BAD_REQUEST", "Send 1 to 10 games", 400);

  const lines: Record<string, ReturnType<typeof out>> = {};
  const { data: rows, error } = await supabase.from("peak_lines")
    .select("key, line, by, score, oc_id, final, model, created_at").in("key", keys);
  if (error) throw new Fail("SERVER", `peak_lines read: ${error.message}`, 500);
  const old = new Map<string, Row>();
  for (const r of (rows ?? []) as Row[]) {
    old.set(r.key, r);
    // a stand-in, or a game with no line, is asked again after a day
    const fresh = Date.now() - Date.parse(r.created_at) < DAY;
    if (fresh || (r.final && r.line)) lines[r.key] = out(r);
  }
  const todo = keys.filter((k) => !(k in lines));
  // games with no answer this time (no key yet, today's cap) are left out of
  // the reply, so the app asks again later instead of keeping "no line"
  if (todo.length) {
    if (!DEEPSEEK_KEY) {
      if (!Object.keys(lines).length) throw new Fail("SERVER", "Peak lines are not set up on the server yet", 500);
    } else {
      const { data: verdict, error: rateErr } = await supabase.rpc("peak_line_rate_check", {
        p_uid: uid, p_n: todo.length, p_hour_limit: 1_000_000, p_daily_cap: DAILY_CAP,
      });
      if (rateErr) throw new Fail("SERVER", `peak_line_rate_check: ${rateErr.message}`, 500);
      if (verdict !== "ok") {
        if (!Object.keys(lines).length) throw new Fail("RATE_LIMIT", "Today's limit is reached; try again tomorrow", 429, 3600);
      } else {
        const made = (await Promise.all(todo.map((k) => make(k, old.get(k))))).filter((m): m is Row => !!m);
        for (const m of made) lines[m.key] = out(m);
        if (made.length) {
          const { error: e2 } = await supabase.from("peak_lines").upsert(made);
          if (e2) console.warn("peak_lines write:", e2.message);
        }
        if (!Object.keys(lines).length) throw new Fail("SERVER", "Couldn't write lines right now; try again later", 502);
      }
    }
  }
  return json({ ok: true, data: { lines } });
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
