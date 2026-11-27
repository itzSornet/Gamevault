-- Game prices (IsThereAnyDeal), served by the game-prices Edge Function.
-- The ITAD key lives only in the function's secrets (ITAD_KEY); clients never
-- see it and never read these tables directly.

-- Steam AppID -> IsThereAnyDeal game id (null = ITAD has no such game)
create table public.price_ids (
  steam_appid integer primary key,
  itad_id     text,
  fetched_at  timestamptz not null default now()
);

-- one price answer per country and Steam AppID ("US:1145350"); data is null
-- when ITAD has no price for the game
create table public.price_cache (
  key        text primary key,
  data       jsonb,
  fetched_at timestamptz not null default now()
);

-- how many uncached games each user asked about, for the limits
create table public.price_requests (
  id         bigserial primary key,
  uid        uuid not null,
  n          integer not null,
  created_at timestamptz not null default now()
);
create index price_requests_uid_time on public.price_requests (uid, created_at);
create index price_requests_time on public.price_requests (created_at);

alter table public.price_ids      enable row level security;
alter table public.price_cache    enable row level security;
alter table public.price_requests enable row level security;

-- no client access at all: only the function (service_role) reads and writes
revoke all on table public.price_ids, public.price_cache, public.price_requests from public, anon, authenticated;
grant all on table public.price_ids, public.price_cache, public.price_requests to service_role;
grant usage, select on sequence public.price_requests_id_seq to service_role;

-- 'ok' and records the request, or 'user' / 'global' when a limit is reached.
-- p_n is how many uncached games this request needs from ITAD.
create or replace function public.price_rate_check(p_uid uuid, p_n integer, p_hour_limit integer, p_daily_cap integer)
returns text
language plpgsql
set search_path = ''
as $$
declare
  n_user integer;
  n_all  integer;
begin
  perform pg_advisory_xact_lock(hashtext('gamevault.price_rate'));

  select coalesce(sum(n), 0) into n_user
  from public.price_requests
  where uid = p_uid and created_at > now() - interval '1 hour';
  if n_user + p_n > p_hour_limit then
    return 'user';
  end if;

  select coalesce(sum(n), 0) into n_all
  from public.price_requests
  where created_at > now() - interval '24 hours';
  if n_all + p_n > p_daily_cap then
    return 'global';
  end if;

  insert into public.price_requests (uid, n) values (p_uid, p_n);
  delete from public.price_requests where created_at < now() - interval '2 days';
  return 'ok';
end;
$$;

revoke all on function public.price_rate_check(uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.price_rate_check(uuid, integer, integer, integer) to service_role;
