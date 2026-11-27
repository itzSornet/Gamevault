/* delete-account — a signed-in GameVault user deletes their own account.
 *
 * POST /functions/v1/delete-account
 *   Authorization: Bearer <the user's access token>   apikey: <publishable key>
 *
 * Removes, in order: the user's save archives in storage bucket "saves"
 * (saves/<uid>/...), then the auth user. library_sync, cloud_keys and
 * save_backups rows go with the user (on delete cascade). Anonymous users are
 * refused: they have nothing to delete and the art cache needs them.
 *
 * Response: { ok: true } | { ok: false, error: { code, message } }
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
 */
import { createClient } from "@supabase/supabase-js";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, code: string, message: string) => json(status, { ok: false, error: { code, message } });

async function removeSaves(uid: string): Promise<void> {
  // saves/<uid>/<game>/<file>.gvs — list each game folder, delete its files.
  const { data: folders, error } = await admin.storage.from("saves").list(uid, { limit: 1000 });
  if (error) throw error;
  for (const f of folders ?? []) {
    const prefix = `${uid}/${f.name}`;
    for (;;) {
      const { data: files, error: e2 } = await admin.storage.from("saves").list(prefix, { limit: 100 });
      if (e2) throw e2;
      if (!files || !files.length) break;
      const { error: e3 } = await admin.storage.from("saves").remove(files.map((x) => `${prefix}/${x.name}`));
      if (e3) throw e3;
      if (files.length < 100) break;
    }
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(405, "BAD_REQUEST", "Use POST");
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return fail(401, "UNAUTHENTICATED", "Sign in first");
  const { data, error } = await admin.auth.getUser(token);
  const user = data?.user;
  if (error || !user?.id) return fail(401, "UNAUTHENTICATED", "Your sign-in has expired. Sign in again.");
  if (user.is_anonymous) return fail(403, "ANONYMOUS", "There is no account to delete");
  try {
    await removeSaves(user.id);
    const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
    if (delErr) throw delErr;
    return json(200, { ok: true });
  } catch (e) {
    console.error("delete-account", user.id, e);
    return fail(500, "SERVER", "Couldn’t delete everything. Try again in a moment.");
  }
});
