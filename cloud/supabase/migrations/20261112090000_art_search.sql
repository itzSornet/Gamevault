-- Title search ("type a name, see matching games") gets its own cache and its
-- own, bigger rate bucket. One search = one SteamGridDB autocomplete call,
-- while a game lookup is 5-6 calls; sharing the 60/hour game budget made
-- search-as-you-type run dry after a few minutes.

create table public.art_searches (
  term       text        primary key,
  candidates jsonb       not null default '[]'::jsonb,
  fetched_at timestamptz not null default now()
);
comment on table public.art_searches is
  'Cached SteamGridDB autocomplete results per normalized term. Service role only.';

alter table public.art_searches enable row level security;
revoke all on table public.art_searches from anon, authenticated;
grant all on table public.art_searches to service_role;

-- Which bucket a counted request belongs to: 'game' (lookups, picker pages)
-- or 'search' (autocomplete). Existing rows are game lookups.
alter table public.art_requests add column kind text not null default 'game'
  check (kind in ('game', 'search'));
drop index if exists public.art_requests_uid_created_idx;
drop index if exists public.art_requests_created_idx;
create index art_requests_kind_uid_created_idx on public.art_requests (kind, uid, created_at);
create index art_requests_kind_created_idx on public.art_requests (kind, created_at);

-- Game bucket: same as before, but only counts game requests.
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
  where kind = 'game' and uid = p_uid and created_at > now() - interval '1 hour';
  if n_user >= p_hour_limit then
    return 'user';
  end if;

  select count(*) into n_all
  from public.art_requests
  where kind = 'game' and created_at > now() - interval '24 hours';
  if n_all >= p_daily_cap then
    return 'global';
  end if;

  insert into public.art_requests (uid, kind) values (p_uid, 'game');
  delete from public.art_requests where created_at < now() - interval '2 days';
  return 'ok';
end;
$$;

-- Search bucket.
create or replace function public.art_search_rate_check(p_uid uuid, p_hour_limit integer, p_daily_cap integer)
returns text
language plpgsql
set search_path = ''
as $$
declare
  n_user integer;
  n_all  integer;
begin
  perform pg_advisory_xact_lock(hashtext('gamevault.art_search_rate'));

  select count(*) into n_user
  from public.art_requests
  where kind = 'search' and uid = p_uid and created_at > now() - interval '1 hour';
  if n_user >= p_hour_limit then
    return 'user';
  end if;

  select count(*) into n_all
  from public.art_requests
  where kind = 'search' and created_at > now() - interval '24 hours';
  if n_all >= p_daily_cap then
    return 'global';
  end if;

  insert into public.art_requests (uid, kind) values (p_uid, 'search');
  delete from public.art_requests where created_at < now() - interval '2 days';
  return 'ok';
end;
$$;

revoke all on function public.art_search_rate_check(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.art_search_rate_check(uuid, integer, integer) to service_role;
