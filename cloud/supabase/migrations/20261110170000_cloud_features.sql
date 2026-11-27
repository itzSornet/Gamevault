-- GameVault cloud features for signed-in (non-anonymous) users:
--   library_sync   one library snapshot per user (games without file paths)
--   cloud_keys     the user's random save-encryption key (created once, never changed)
--   save_backups   one row per encrypted save archive in the private `saves` bucket
-- Storage objects live at saves/<user id>/<game id>/<timestamp>.gvs.
-- Everything is scoped to auth.uid() by RLS; anonymous sessions get nothing.

create or replace function public.gv_is_member()
returns boolean
language sql stable
set search_path = ''
as $$
  select auth.uid() is not null
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
$$;
comment on function public.gv_is_member() is 'True for a signed-in, non-anonymous user.';

-- ---------------------------------------------------------------- library

create table public.library_sync (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb       not null,
  version    bigint      not null default 1,
  device     text,
  updated_at timestamptz not null default now(),
  constraint library_sync_size check (pg_column_size(data) < 8 * 1024 * 1024)
);
comment on table public.library_sync is
  'Synced library per user: {games:[...], tombstones:{id: ms}}. No file paths, no keys. version guards concurrent writes.';

alter table public.library_sync enable row level security;
create policy library_sync_select on public.library_sync for select to authenticated
  using (public.gv_is_member() and user_id = (select auth.uid()));
create policy library_sync_insert on public.library_sync for insert to authenticated
  with check (public.gv_is_member() and user_id = (select auth.uid()));
create policy library_sync_update on public.library_sync for update to authenticated
  using (public.gv_is_member() and user_id = (select auth.uid()))
  with check (public.gv_is_member() and user_id = (select auth.uid()));
create policy library_sync_delete on public.library_sync for delete to authenticated
  using (public.gv_is_member() and user_id = (select auth.uid()));

-- ---------------------------------------------------------------- keys

create table public.cloud_keys (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  save_key   text        not null check (length(save_key) between 40 and 100),
  created_at timestamptz not null default now()
);
comment on table public.cloud_keys is
  'Random AES-256 key (base64) that encrypts the user''s save archives on their PCs. Insert once, never updated.';

alter table public.cloud_keys enable row level security;
create policy cloud_keys_select on public.cloud_keys for select to authenticated
  using (public.gv_is_member() and user_id = (select auth.uid()));
create policy cloud_keys_insert on public.cloud_keys for insert to authenticated
  with check (public.gv_is_member() and user_id = (select auth.uid()));

-- ---------------------------------------------------------------- saves

create table public.save_backups (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  game_id     text        not null check (length(game_id) between 1 and 80),
  game_name   text        check (length(game_name) <= 300),
  object_path text        not null unique check (length(object_path) <= 300),
  size        bigint      not null check (size >= 0),
  files       integer     not null default 0,
  device      text        check (length(device) <= 120),
  created_at  timestamptz not null default now()
);
comment on table public.save_backups is 'One encrypted save archive in storage bucket "saves".';
create index save_backups_user_game_idx on public.save_backups (user_id, game_id, created_at desc);

alter table public.save_backups enable row level security;
create policy save_backups_select on public.save_backups for select to authenticated
  using (public.gv_is_member() and user_id = (select auth.uid()));
create policy save_backups_insert on public.save_backups for insert to authenticated
  with check (public.gv_is_member() and user_id = (select auth.uid())
              and object_path like (select auth.uid())::text || '/%');
create policy save_backups_delete on public.save_backups for delete to authenticated
  using (public.gv_is_member() and user_id = (select auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('saves', 'saves', false, 52428800, array['application/octet-stream'])
on conflict (id) do nothing;

create policy saves_select on storage.objects for select to authenticated
  using (bucket_id = 'saves' and public.gv_is_member()
         and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy saves_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'saves' and public.gv_is_member()
              and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy saves_delete on storage.objects for delete to authenticated
  using (bucket_id = 'saves' and public.gv_is_member()
         and (storage.foldername(name))[1] = (select auth.uid())::text);

grant select, insert, update, delete on public.library_sync to authenticated;
grant select, insert on public.cloud_keys to authenticated;
grant select, insert, delete on public.save_backups to authenticated;
revoke all on public.library_sync, public.cloud_keys, public.save_backups from anon;

-- Supabase's default privileges also grant TRUNCATE/REFERENCES/TRIGGER, and
-- TRUNCATE ignores RLS: take them away so one user can't wipe everyone's rows.
revoke truncate, references, trigger on public.library_sync, public.cloud_keys, public.save_backups from authenticated, anon;
