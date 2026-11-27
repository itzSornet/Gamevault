# GameVault cloud: one-time setup (Supabase, free plan)

The 2.0 cloud features run on **Supabase's free plan**. You need no credit card.
Milestone **M2** is a shared SteamGridDB artwork cache, so nobody needs their own
SteamGridDB key. The first time anyone asks for a game, the server looks it up
once with *your* key and stores the asset metadata and SteamGridDB CDN URLs
(never the images). Everyone after that reads the cache. Later milestones add
sign-in, library sync and encrypted save backup.

What's in this folder:

| Path | What it is |
|---|---|
| `supabase/migrations/20261110103456_art_cache.sql` | Tables `art_games`, `art_index`, `art_requests`, `art_inflight`, RLS, helper functions |
| `supabase/functions/art-lookup/` | The Edge Function (`index.ts` = wiring + documented response shape, `lib.ts` = logic) |
| `supabase/tests/` | `database/*.test.sql` (pgTAP) and `functions/*.test.ts` (Deno, no network) |
| `supabase/config.toml` | Local `supabase start` / `functions serve` settings |
| `../.github/workflows/supabase-keepalive.yml` | Daily ping so the free project never pauses |

> **Never paste keys or passwords into the chat.** That covers your SteamGridDB
> key, the database password, the `service_role` / secret key and the Google
> client secret. Type them only into the Supabase dashboard, Google Cloud or
> GitHub, in the places named below.

## 1. Create the account and project (≈5 min)
1. Go to https://supabase.com and **Start your project**. Sign up with GitHub or
   email. The free plan asks for no card.
2. **New project** → organisation: your personal one (Free plan) → name
   `gamevault` → **Database password**: click *Generate*, save it in your
   password manager (you need it for `supabase link`) → region near you → **Create**.
3. Wait about 2 minutes for it to finish provisioning.

## 2. Copy the two public values
**Project Settings → API Keys** (older dashboards: **Settings → API**):
- **Project URL**: `https://<project-ref>.supabase.co`. The `<project-ref>` part
  (20 letters) is used below.
- **anon / publishable key**. This one is public by design: it ships inside the
  desktop app and only grants what RLS allows (read the art cache).

Do **not** copy the `service_role` / secret key anywhere. Edge Functions get it
automatically.

## 3. Store your SteamGridDB key as a server secret
**Edge Functions → Secrets** (or **Project Settings → Edge Functions**) → **Add new secret**:
- Name `SGDB_KEY`, value: your key from https://www.steamgriddb.com/profile/preferences/api
- Optional: `ART_DAILY_CAP` (default `2000` new games per 24 h for everyone
  together) and `ART_HOURLY_LIMIT` (default `60` new games per hour per install).

The key never leaves Supabase. The app and the database never see it.

## 4. Turn on sign-in
**Authentication → Sign In / Providers** (older: **Authentication → Providers**):
- **Allow anonymous sign-ins**: **on**. Every install silently gets an
  anonymous user. The artwork function requires one, so the rate limits work per install.
- **Email**: on. Turning *Confirm email* on is fine for real users.
- **Google**: on. It needs a client ID and secret from Google:
  1. https://console.cloud.google.com → create or select a project → **APIs &
     Services → OAuth consent screen**: External, app name `GameVault`, your
     support email, scopes `openid`, `email`, `profile`. While the app is in
     *Testing*, add yourself as a test user.
  2. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
     type **Web application** → **Authorized redirect URIs**:
     `https://<project-ref>.supabase.co/auth/v1/callback`
  3. Copy the **Client ID** and **Client secret** into Supabase's Google provider
     form → **Save**.

**Authentication → URL Configuration**:
- **Site URL**: `http://127.0.0.1`
- **Redirect URLs**: add `http://127.0.0.1/**` and `http://127.0.0.1:*/**`.
  The desktop app catches the sign-in on a loopback port it chooses at runtime.

## 5. Deploy the database and the function (Supabase CLI)
Install the CLI once. Pick one:
```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```
or put `npx supabase` in place of `supabase` in every command below
(`npm install -g supabase` is not supported).

Then, from the repo's `cloud` folder:
```powershell
cd C:\projects\gamevault\cloud
supabase login                               # opens the browser
supabase link --project-ref <project-ref>    # asks for the database password
supabase db push                             # applies supabase/migrations/*
supabase functions deploy art-lookup         # reads verify_jwt = false from config.toml
```
If `functions deploy` complains that Docker isn't running, add `--use-api`.
The function checks the user's token itself, so turning off the gateway JWT
check (`verify_jwt = false`) is intentional.

**Smoke test** (in your own PowerShell, not in the chat). It signs in
anonymously, then asks for Counter-Strike 2's art:
```powershell
$url = "https://<project-ref>.supabase.co"; $anon = Read-Host "anon key"
$s = Invoke-RestMethod -Method Post "$url/auth/v1/signup" -Headers @{ apikey = $anon } -ContentType "application/json" -Body "{}"
Invoke-RestMethod -Method Post "$url/functions/v1/art-lookup" -Headers @{ apikey = $anon; Authorization = "Bearer $($s.access_token)" } -ContentType "application/json" -Body '{"steamAppId":730}' | ConvertTo-Json -Depth 6
```
The first run shows `"source": "sgdb"`. Run the last line again and it shows `"source": "cache"`.

## 6. Local development (optional; needs Docker Desktop)
```powershell
cd C:\projects\gamevault\cloud
copy supabase\functions\.env.example supabase\functions\.env   # then put your SGDB key in it
supabase start                 # local Postgres/Auth/REST on :54321-54323
supabase functions serve       # http://127.0.0.1:54321/functions/v1/art-lookup
supabase test db               # pgTAP: supabase/tests/database
cd supabase; deno task test    # handler unit tests, no network or Docker
```

## 7. Keep the free project awake (GitHub Actions)
Free projects **pause after 7 days with no activity**.
`.github/workflows/supabase-keepalive.yml` reads the cache once a day to prevent that.
GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
- `SUPABASE_URL` = `https://<project-ref>.supabase.co`
- `SUPABASE_ANON_KEY` = the anon / publishable key from step 2

Without them the job just logs a notice and passes. GitHub runs scheduled
workflows **only from the default branch** (`main`), so the ping starts once
this file is merged there. You can also run it by hand: **Actions → Supabase
keep-alive → Run workflow**. GitHub also turns schedules off in repos with no
commits for 60 days, so re-enable it under Actions if you get that email.

Free plan limits that matter here: 500 MB database, 500k Edge Function
calls/month, 50k monthly active users, 2 free projects. The art cache stores
about 5–10 KB per game.

## 8. Ask SteamGridDB for permission (important)
Their Terms (steamgriddb.com/terms) say the service is for "personal,
non-commercial use" and must not be distributed "without our explicit written
permission". A shared server cache serving everyone with one key needs their OK.
Until they reply, the shared cache stays for your own testing only.

Draft you can send (email jozen@steamgriddb.com, or the SteamGridDB Discord):

> Hi! I'm building GameVault, a free open-source game library manager
> (github.com/itzSornet/Gamevault). I'd like users to get artwork without each
> creating an API key. Plan: a small server with my key looks a game up once,
> stores only the asset metadata and your CDN URLs (images are not re-hosted),
> and serves later requests from that cache — so it should cut traffic to your
> API. Results are refreshed every 30 days, rate-limited per install, and the
> app credits SteamGridDB. Is that OK, and is there anything you'd like me to
> change (attribution, limits, a different approach)? Thanks!

## 9. Backblaze B2 (for M4, later)
Encrypted save backups will go to Backblaze B2. The first 10 GB of storage are
free, and egress is free up to 3× what you store. Nothing to do yet. When M4
starts:
1. Create a B2 account at https://www.backblaze.com/sign-up/cloud-storage. The free tier asks for no card.
2. Create a **private** bucket, e.g. `gamevault-saves-<random>`.
3. Create an **Application Key** limited to that bucket (read + write). It goes
   into Supabase **Edge Functions → Secrets** as `B2_KEY_ID` / `B2_APP_KEY`,
   never into the app or the chat.
Saves are encrypted on the user's machine before upload. The server only hands
out short-lived upload/download URLs.

## 10. Hand-off
Tell Claude:
- your **project ref** (the `<ref>` in `https://<ref>.supabase.co`),
- that steps 3–5 are done (the smoke test printed `"source": "cache"` on the second run),
- whether SteamGridDB said yes.

Don't paste any key into the chat, not even the anon key. The desktop app will
read the URL and anon key from a config file you fill in yourself.
