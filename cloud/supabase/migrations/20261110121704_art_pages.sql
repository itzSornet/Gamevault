-- GameVault M2b: browsable artwork pages for the picker ("show more").
--
-- art_games keeps only the ranked top 8 per kind (for auto-pick). When a user
-- opens the picker and scrolls, the app asks for SteamGridDB page 0, 1, 2...
-- of one kind. Each page (up to 50 items, SteamGridDB's own order, unsafe
-- items removed) is cached here on first request, so only games people
-- actually browse take up space.

create table public.art_pages (
  sgdb_id    bigint      not null references public.art_games (sgdb_id) on delete cascade,
  kind       text        not null check (kind in ('grids', 'heroes', 'logos', 'icons')),
  page       integer     not null check (page between 0 and 49),
  items      jsonb       not null default '[]'::jsonb,
  has_more   boolean     not null default false,
  fetched_at timestamptz not null default now(),
  primary key (sgdb_id, kind, page)
);
comment on table public.art_pages is
  'One SteamGridDB result page (<=50 assets, metadata + CDN URLs) per game/kind/page. Written by art-lookup only.';

alter table public.art_pages enable row level security;
create policy art_pages_public_read on public.art_pages
  for select to anon, authenticated using (true);

revoke all on table public.art_pages from anon, authenticated;
grant select on table public.art_pages to anon, authenticated;
grant all on table public.art_pages to service_role;

-- Upsert one page and drop the claim, in one transaction.
create or replace function public.art_store_page(
  p_sgdb_id   bigint,
  p_kind      text,
  p_page      integer,
  p_items     jsonb,
  p_has_more  boolean,
  p_claim_key text
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.art_pages as p (sgdb_id, kind, page, items, has_more, fetched_at)
  values (p_sgdb_id, p_kind, p_page, coalesce(p_items, '[]'::jsonb), coalesce(p_has_more, false), now())
  on conflict (sgdb_id, kind, page) do update
    set items      = excluded.items,
        has_more   = excluded.has_more,
        fetched_at = excluded.fetched_at;
  if p_claim_key is not null then
    delete from public.art_inflight where key = p_claim_key;
  end if;
end;
$$;

revoke all on function public.art_store_page(bigint, text, integer, jsonb, boolean, text) from public, anon, authenticated;
grant execute on function public.art_store_page(bigint, text, integer, jsonb, boolean, text) to service_role;
