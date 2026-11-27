-- pgTAP checks for migrations/20261110103456_art_cache.sql and 20261110121704_art_pages.sql.
--   cd cloud && supabase start && supabase test db
-- Runs in a transaction that is rolled back, so it leaves no data behind.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(38);

-- ---------------------------------------------------------- structure
select has_table('public', 'art_games', 'art_games exists');
select has_table('public', 'art_index', 'art_index exists');
select has_table('public', 'art_requests', 'art_requests exists');
select has_table('public', 'art_inflight', 'art_inflight exists');
select has_table('public', 'art_pages', 'art_pages exists');
select ok((select bool_and(relrowsecurity) from pg_class
           where oid in ('public.art_games'::regclass, 'public.art_index'::regclass,
                         'public.art_requests'::regclass, 'public.art_inflight'::regclass,
                         'public.art_pages'::regclass)),
          'RLS is enabled on all five tables');

-- ------------------------------------------- service role: miss writes once
set local role service_role;

select is(public.art_claim('steam:730', 30), true,  'first claim wins');
select is(public.art_claim('steam:730', 30), false, 'concurrent second claim loses');

select lives_ok($$
  select public.art_store(7, 'Counter-Strike 2', 730, '{"verified":true}',
                          '{"v":1,"grids":{"items":[],"total":0,"hasMore":false}}',
                          array['steam:730'], null, 'steam:730')
$$, 'art_store writes a game + index row');
select is((select count(*)::int from public.art_inflight where key = 'steam:730'), 0, 'art_store drops the claim');
select is((select count(*)::int from public.art_games where sgdb_id = 7), 1, 'one art_games row');

-- Same game again (e.g. stale refresh): still one row, fetched_at moves.
select lives_ok($$
  select public.art_store(7, 'Counter-Strike 2', null, '{}', '{"v":1}', array['steam:730', 'term:cs2'],
                          '[{"id":7,"name":"Counter-Strike 2"}]', null)
$$, 'art_store is an idempotent upsert');
select is((select count(*)::int from public.art_games where sgdb_id = 7), 1, 'still one art_games row after upsert');
select is((select steam_appid from public.art_games where sgdb_id = 7), 730, 'null steam_appid keeps the known one');
select is((select candidates->0->>'name' from public.art_index where key = 'term:cs2'), 'Counter-Strike 2',
          'term keys store candidates');

select lives_ok($$ select public.art_store_miss('steam:424242', null) $$, 'negative cache row');
select ok((select sgdb_id is null from public.art_index where key = 'steam:424242'), 'miss stored as NULL sgdb_id');

select throws_ok($$ insert into public.art_index (key) values ('Steam:730 ') $$, '23514', null,
                 'index keys must be normalised lowercase/trimmed');

-- Picker pages: one row per (game, kind, page), upsert keeps it at one.
select lives_ok($$ select public.art_store_page(7, 'grids', 0, '[{"id":1}]', true, null) $$, 'art_store_page writes a page');
select lives_ok($$ select public.art_store_page(7, 'grids', 0, '[{"id":1},{"id":2}]', false, null) $$, 'art_store_page upserts');
select is((select jsonb_array_length(items) from public.art_pages where sgdb_id = 7 and kind = 'grids' and page = 0), 2,
          'still one page row, with the newer items');
select throws_ok($$ select public.art_store_page(424242, 'grids', 0, '[]', false, null) $$, '23503', null,
                 'a page needs its game row (foreign key)');

-- Rate limit: 2 per uid per hour, then 'user'; global cap of 3 then 'global'.
select is(public.art_rate_check('00000000-0000-0000-0000-00000000000a', 2, 3), 'ok',   'rate 1 ok');
select is(public.art_rate_check('00000000-0000-0000-0000-00000000000a', 2, 3), 'ok',   'rate 2 ok');
select is(public.art_rate_check('00000000-0000-0000-0000-00000000000a', 2, 3), 'user', 'per-user hourly limit');
select is(public.art_rate_check('00000000-0000-0000-0000-00000000000b', 2, 3), 'ok',   'other user ok');
select is(public.art_rate_check('00000000-0000-0000-0000-00000000000c', 2, 3), 'global', 'global daily cap');

reset role;

-- ------------------------------------------------ clients: read-only cache
set local role anon;
select is((select count(*)::int from public.art_games where sgdb_id = 7), 1, 'anon can read art_games');
select throws_ok($$ insert into public.art_games (sgdb_id, name) values (99, 'x') $$, '42501', null,
                 'anon cannot insert art_games');
select throws_ok($$ select public.art_rate_check('00000000-0000-0000-0000-00000000000a', 999, 999) $$, '42501', null,
                 'anon cannot call art_rate_check');
select is((select count(*)::int from public.art_pages where sgdb_id = 7), 1, 'anon can read art_pages');
select throws_ok($$ insert into public.art_pages (sgdb_id, kind, page) values (7, 'logos', 0) $$, '42501', null,
                 'anon cannot insert art_pages');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select is((select count(*)::int from public.art_index where key = 'steam:730'), 1, 'authenticated can read art_index');
select throws_ok($$ update public.art_games set name = 'pwned' where sgdb_id = 7 $$, '42501', null,
                 'authenticated cannot update art_games');
select throws_ok($$ delete from public.art_index $$, '42501', null,
                 'authenticated cannot delete art_index');
select throws_ok($$ insert into public.art_index (key, sgdb_id) values ('steam:1', 7) $$, '42501', null,
                 'authenticated cannot insert art_index');
select throws_ok($$ select count(*) from public.art_requests $$, '42501', null,
                 'authenticated cannot read art_requests');
select throws_ok($$ select public.art_store(1, 'x', null, '{}', '{}', array['steam:1'], null, null) $$, '42501', null,
                 'authenticated cannot call art_store');
reset role;

select * from finish();
rollback;
