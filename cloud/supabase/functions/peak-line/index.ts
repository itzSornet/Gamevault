/* peak-line: one line about a game for its Peak scroll, written by DeepSeek
 * through GameVault Cloud. Written once per game and shared: everyone with
 * the same game at PEAK reads the same line.
 *
 * POST /functions/v1/peak-line
 *   Authorization: Bearer <user access token>   (anonymous sign-in is fine)
 *   apikey: <project anon/publishable key>
 *   Body: { games: [{ steamAppId?: number, itadId?: string }] (1..10) }
 *
 * Response (HTTP 200):
 *   { ok: true, data: { lines: { ["steam:<appid>" | "itad:<id>"]: string | null } } }
 *   null = no line (no facts about the game, or no draft passed the checks);
 *   asked again after a day. A game left out = no answer this time (no key
 *   on the server yet, or a limit reached).
 *
 * The facts come from here, never from the app (Steam's store page, and
 * IsThereAnyDeal's tags), so no one can plant a line for everyone else.
 * Nothing about the user is sent to DeepSeek: only the game's facts.
 *
 * Failure: { ok: false, error: { code, message } } with 400 BAD_REQUEST,
 *   401 UNAUTHENTICATED, 429 RATE_LIMIT (+ Retry-After), 500 SERVER.
 *
 * Caching: a line is kept for good; a game with no line is asked again after
 * a day. Limits count only new lines: PEAK_HOURLY_LIMIT per user (default
 * 30), PEAK_DAILY_CAP overall (default 3000, about $1 a day at most).
 *
 * Env (Dashboard -> Edge Functions -> Secrets): DEEPSEEK_KEY (required for
 * new lines), ITAD_KEY (optional: tags). SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
 */
import { createClient } from "@supabase/supabase-js";

const DAY = 24 * 3600 * 1000;
const MODEL = "deepseek-flash";

function intEnv(name: string, fallback: number): number {
  const n = Number(Deno.env.get(name));
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const DEEPSEEK_KEY = Deno.env.get("DEEPSEEK_KEY") ?? "";
const ITAD_KEY = Deno.env.get("ITAD_KEY") ?? "";
const HOUR_LIMIT = intEnv("PEAK_HOURLY_LIMIT", 30);
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

const BANNED = /\b(epic|award|acclaimed|masterpiece|must-?play|experience|journey|immersive|stunning|breathtaking|unforgettable|ultimate|iconic|legendary|groundbreaking)\b/i;
const norm = (t: string) => String(t || "").toLowerCase().replace(/[™®©]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
const text = (h: string) => String(h || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

type Facts = { title: string; developer: string[]; publisher: string[]; genres: string[]; tags: string[]; about: string };

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

/** Why a draft breaks the rules, or "" when it is fine. */
function problem(line: string, f: Facts): string {
  const words = line.split(/\s+/).filter(Boolean).length;
  if (words < 8 || words > 30) return "It must be one sentence of 12 to 25 words.";
  if ((line.match(/[.!?](\s|$)/g) || []).length > 1) return "It must be a single sentence.";
  if (/[!#"“”]|\p{Extended_Pictographic}/u.test(line)) return "No exclamation marks, quotation marks, hashtags or emoji.";
  if (BANNED.test(line)) return `Do not use the word "${line.match(BANNED)![0]}".`;
  if (/\b(I|me|my|mine|we|our|us)\b/i.test(line)) return "Speak to the reader as you; never I, me, my or we.";
  const all = `${f.title} ${f.about} ${f.tags.join(" ")} ${f.genres.join(" ")}`;
  for (const n of line.match(/\d+/g) || []) if (!all.includes(n)) return `Do not use the number ${n}; it is not in the facts.`;
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

/** A line that passed the checks, in at most two tries; null when none did. */
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

  const lines: Record<string, string | null> = {};
  const { data: rows, error } = await supabase.from("peak_lines").select("key, line, created_at").in("key", keys);
  if (error) throw new Fail("SERVER", `peak_lines read: ${error.message}`, 500);
  for (const r of rows ?? []) {
    if (r.line || Date.now() - Date.parse(r.created_at) < DAY) lines[r.key] = r.line;
  }
  const todo = keys.filter((k) => !(k in lines));
  // games with no answer this time (no key yet, a limit) are left out of the
  // reply, so the app asks again later instead of keeping "no line"
  if (todo.length) {
    if (!DEEPSEEK_KEY) {
      if (!Object.keys(lines).length) throw new Fail("SERVER", "Peak lines are not set up on the server yet", 500);
    } else {
      const { data: verdict, error: rateErr } = await supabase.rpc("peak_line_rate_check", {
        p_uid: uid, p_n: todo.length, p_hour_limit: HOUR_LIMIT, p_daily_cap: DAILY_CAP,
      });
      if (rateErr) throw new Fail("SERVER", `peak_line_rate_check: ${rateErr.message}`, 500);
      if (verdict !== "ok") {
        if (!Object.keys(lines).length) {
          throw new Fail("RATE_LIMIT", verdict === "user" ? "Too many new lines; try again later" : "Today's limit is reached; try again tomorrow", 429, verdict === "user" ? 900 : 3600);
        }
      } else {
        // DeepSeek failing (bad key, down) leaves the game out: asked again later
        const made = (await Promise.all(todo.map(async (k) => {
          const f = await factsFor(k);
          let line: string | null = null;
          if (f) {
            try { line = await write(f); } catch (err) { console.warn("peak-line:", (err as Error).message); return null; }
          }
          return { key: k, line, model: line ? MODEL : null, created_at: new Date().toISOString() };
        }))).filter((m): m is NonNullable<typeof m> => !!m);
        for (const m of made) lines[m.key] = m.line;
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
