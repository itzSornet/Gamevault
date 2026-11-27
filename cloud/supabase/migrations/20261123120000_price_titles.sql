-- Game title -> IsThereAnyDeal game (and its Steam AppID), for games the app
-- has no Steam AppID for. Served by the game-prices Edge Function only.
-- norm is the title lowercased with only letters and digits kept;
-- itad_id is null when ITAD has no such game.
create table public.price_titles (
  norm       text primary key,
  itad_id    text,
  title      text,
  appid      integer,
  fetched_at timestamptz not null default now()
);

alter table public.price_titles enable row level security;
revoke all on table public.price_titles from public, anon, authenticated;
grant all on table public.price_titles to service_role;
