-- One line about a game for its Peak scroll, written once by the peak-line
-- Edge Function (DeepSeek) and shared by everyone who has that game at PEAK.
-- key: "steam:<appid>" or "itad:<IsThereAnyDeal id>"; line is null when no
-- line passed the checks (asked again after a day).
create table public.peak_lines (
  key        text primary key,
  line       text,
  model      text,
  created_at timestamptz not null default now()
);

-- how many new lines each user asked for, for the limits
create table public.peak_line_requests (
  id         bigserial primary key,
  uid        uuid not null,
  n          integer not null,
  created_at timestamptz not null default now()
);
create index peak_line_requests_uid_time on public.peak_line_requests (uid, created_at);
create index peak_line_requests_time on public.peak_line_requests (created_at);

alter table public.peak_lines         enable row level security;
alter table public.peak_line_requests enable row level security;
revoke all on table public.peak_lines, public.peak_line_requests from public, anon, authenticated;
grant all on table public.peak_lines, public.peak_line_requests to service_role;
grant usage, select on sequence public.peak_line_requests_id_seq to service_role;

-- 'ok' and records the request, or 'user' / 'global' when a limit is reached
create or replace function public.peak_line_rate_check(p_uid uuid, p_n integer, p_hour_limit integer, p_daily_cap integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  mine  integer;
  today integer;
begin
  perform pg_advisory_xact_lock(hashtext('peak_line_rate'));
  select coalesce(sum(n), 0) into mine from peak_line_requests
    where uid = p_uid and created_at > now() - interval '1 hour';
  if mine + p_n > p_hour_limit then return 'user'; end if;
  select coalesce(sum(n), 0) into today from peak_line_requests
    where created_at > now() - interval '1 day';
  if today + p_n > p_daily_cap then return 'global'; end if;
  insert into peak_line_requests (uid, n) values (p_uid, p_n);
  delete from peak_line_requests where created_at < now() - interval '2 days';
  return 'ok';
end;
$$;
revoke all on function public.peak_line_rate_check(uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.peak_line_rate_check(uuid, integer, integer, integer) to service_role;
