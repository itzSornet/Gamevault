-- GameVault M2: shared SteamGridDB artwork cache.
--
-- Only asset METADATA and SteamGridDB CDN URLs live here, never image bytes.
-- Clients (anon + signed-in) may READ art_games / art_index directly through
-- PostgREST. Every write goes through the `art-lookup` Edge Function, which
-- uses the service role and the helper functions below.
--
-- Additions beyond the original M2 sketch (all nullable / defaulted):
--   art_games.info        {releaseDate, types, verified} from SteamGridDB
--   art_index.sgdb_id     NULL = negative cache ("SteamGridDB has nothing")
--   art_index.candidates  autocomplete hits for term:* keys, so the desktop
--                         client can fuzzy-match and re-ask by sgdbId
--   art_inflight          claim table that dedupes concurrent misses

-- ---------------------------------------------------------------- tables

create table public.art_games (
  sgdb_id     bigint      primary key,
  name        text        not null,
  steam_appid integer,
  info        jsonb       not null default '{}'::jsonb,
  assets      jsonb       not null default '{}'::jsonb,
  fetched_at  timestamptz not null default now()
);
comment on table public.art_games is
  'One row per SteamGridDB game: ranked asset metadata + CDN URLs. Written by art-lookup only.';
create index art_games_steam_appid_idx on public.art_games (steam_appid) where steam_appid is not null;

create table public.art_index (
  key        text        primary key,
  sgdb_id    bigint      references public.art_games (sgdb_id) on delete cascade,
  candidates jsonb,
  created_at timestamptz not null default now(),
  constraint art_index_key_format check (
    key = lower(btrim(key))
    and key ~ '^(steam:[0-9]+|term:.+)$'
    and length(key) <= 140
  )
);
comment on table public.art_index is
  'Lookup key (steam:730, term:god of war) -> SteamGridDB game. sgdb_id NULL = known miss.';
comment on column public.art_index.created_at is 'When this mapping was last (re)written.';
create index art_index_sgdb_id_idx on public.art_index (sgdb_id);

create table public.art_requests (
  id         bigint      generated always as identity primary key,
  uid        uuid        not null,
  created_at timestamptz not null default now()
);
comment on table public.art_requests is
  'One row per cache miss that reached SteamGridDB; used for rate limiting. No client access.';
create index art_requests_uid_created_idx on public.art_requests (uid, created_at);
create index art_requests_created_idx on public.art_requests (created_at);

create table public.art_inflight (
  key        text        primary key,
  claimed_at timestamptz not null default now()
);
comment on table public.art_inflight is
  'Short-lived claims so concurrent misses for one key hit SteamGridDB once. No client access.';

-- ------------------------------------------------------------------- RLS

alter table public.art_games    enable row level security;
alter table public.art_index    enable row level security;
alter table public.art_requests enable row level security;
alter table public.art_inflight enable row level security;

create policy art_games_public_read on public.art_games
  for select to anon, authenticated using (true);
create policy art_index_public_read on public.art_index
  for select to anon, authenticated using (true);
-- art_requests / art_inflight: RLS on and no policies = no rows for clients.

-- Belt and braces: Supabase grants ALL on new public tables to anon and
-- authenticated by default. Take writes away at the privilege level too, so a
-- future permissive policy cannot accidentally open them.
revoke all on table public.art_games, public.art_index,
                    public.art_requests, public.art_inflight
  from anon, authenticated;
grant select on table public.art_games, public.art_index to anon, authenticated;
grant all on table public.art_games, public.art_index,
                   public.art_requests, public.art_inflight
  to service_role;
grant usage, select on sequence public.art_requests_id_seq to service_role;

-- -------------------------------------------- service-role helper functions
-- All plain SECURITY INVOKER functions: they only work for a caller that
-- already has write access (service_role). EXECUTE is revoked from clients.

-- Try to claim `p_key` for a SteamGridDB fetch. True = you own it; false =
-- someone else claimed it less than p_ttl_seconds ago (wait for their result).
create or replace function public.art_claim(p_key text, p_ttl_seconds integer default 30)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  won boolean;
begin
  insert into public.art_inflight as f (key, claimed_at)
  values (p_key, now())
  on conflict (key) do update
    set claimed_at = excluded.claimed_at
    where f.claimed_at < now() - make_interval(secs => p_ttl_seconds)
  returning true into won;
  return coalesce(won, false);
end;
$$;

create or replace function public.art_release(p_key text)
returns void
language sql
set search_path = ''
as $$
  delete from public.art_inflight where key = p_key;
$$;

-- Upsert one game and point every key in p_keys at it, then drop the claim.
-- One transaction, so readers never see an index row without its game.
create or replace function public.art_store(
  p_sgdb_id     bigint,
  p_name        text,
  p_steam_appid integer,
  p_info        jsonb,
  p_assets      jsonb,
  p_keys        text[],
  p_candidates  jsonb,
  p_claim_key   text
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.art_games as g (sgdb_id, name, steam_appid, info, assets, fetched_at)
  values (p_sgdb_id, p_name, p_steam_appid, coalesce(p_info, '{}'::jsonb), p_assets, now())
  on conflict (sgdb_id) do update
    set name        = excluded.name,
        steam_appid = coalesce(excluded.steam_appid, g.steam_appid),
        info        = excluded.info,
        assets      = excluded.assets,
        fetched_at  = excluded.fetched_at;

  insert into public.art_index as i (key, sgdb_id, candidates, created_at)
  select k, p_sgdb_id, case when k like 'term:%' then p_candidates end, now()
  from unnest(coalesce(p_keys, '{}'::text[])) as k
  on conflict (key) do update
    set sgdb_id    = excluded.sgdb_id,
        candidates = coalesce(excluded.candidates, i.candidates),
        created_at = excluded.created_at;

  if p_claim_key is not null then
    delete from public.art_inflight where key = p_claim_key;
  end if;
end;
$$;

-- Remember that SteamGridDB has nothing for p_key (negative cache), drop claim.
create or replace function public.art_store_miss(p_key text, p_claim_key text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.art_index as i (key, sgdb_id, candidates, created_at)
  values (p_key, null, null, now())
  on conflict (key) do update
    set sgdb_id = null, candidates = null, created_at = excluded.created_at;
  if p_claim_key is not null then
    delete from public.art_inflight where key = p_claim_key;
  end if;
end;
$$;

-- Count one SteamGridDB-bound miss for p_uid if both limits allow it.
-- Returns 'ok' (counted), 'user' (per-uid hourly limit hit) or 'global'
-- (rolling 24 h cap hit). A transaction-scoped advisory lock serialises the
-- check-then-insert so concurrent misses cannot overshoot the caps.
create or replace function public.art_rate_check(p_uid uuid, p_hour_limit integer, p_daily_cap integer)
returns text
language plpgsql
set search_path = ''
as $$
declare
  n_user integer;
  n_all  integer;
begin
  perform pg_advisory_xact_lock(hashtext('gamevault.art_rate'));

  select count(*) into n_user
  from public.art_requests
  where uid = p_uid and created_at > now() - interval '1 hour';
  if n_user >= p_hour_limit then
    return 'user';
  end if;

  select count(*) into n_all
  from public.art_requests
  where created_at > now() - interval '24 hours';
  if n_all >= p_daily_cap then
    return 'global';
  end if;

  insert into public.art_requests (uid) values (p_uid);
  delete from public.art_requests where created_at < now() - interval '2 days';
  return 'ok';
end;
$$;

revoke all on function public.art_claim(text, integer)        from public, anon, authenticated;
revoke all on function public.art_release(text)               from public, anon, authenticated;
revoke all on function public.art_store(bigint, text, integer, jsonb, jsonb, text[], jsonb, text)
                                                              from public, anon, authenticated;
revoke all on function public.art_store_miss(text, text)      from public, anon, authenticated;
revoke all on function public.art_rate_check(uuid, integer, integer) from public, anon, authenticated;

grant execute on function public.art_claim(text, integer)        to service_role;
grant execute on function public.art_release(text)               to service_role;
grant execute on function public.art_store(bigint, text, integer, jsonb, jsonb, text[], jsonb, text)
                                                                 to service_role;
grant execute on function public.art_store_miss(text, text)      to service_role;
grant execute on function public.art_rate_check(uuid, integer, integer) to service_role;
