-- pgTAP: public.faq_items, the FAQ (migration 0096, Admin v2 U7).
--
-- The Contact page's FAQ band and its FAQPage JSON-LD read this table through one loader
-- (src/lib/data/faq.ts), so what a visitor reads here is exactly what both say. Held here:
--   1. the catalog: RLS forced, the four policies, the grants (anon six columns, staff and
--      the service role SELECT/INSERT/UPDATE/DELETE, never TRUNCATE), the triggers, the
--      registry row;
--   2. the CHECK: exactly {en, ar}, both non-empty strings, trimmed, at most 200 (question)
--      or 1200 (answer) characters, no control character (a newline included);
--   3. per role (admin, content_creator, seo, developer, anon, other_tenant, a token with no
--      role): anon reads the launch tenant's published rows through its column grant only;
--      staff read all of their tenant's; Admin and Content Creator write and publish; only
--      Admin archives or deletes (RESTRICTIVE); SEO and Developer write nothing; another
--      tenant reads and writes none of it;
--   4. the stamps (version, actor, updated_at), history (content_versions, 'faq_item'),
--      the scheduled publisher, and the release lane (nothing captured while releases are
--      off; with them on, the guard refuses staff and an out-of-band write is one system
--      item);
--   5. the help guide the migration puts (collections-and-faq): every tenant holds it.
-- No stale-token row: no policy or definer here relies on app.live_role() (public content,
-- the general stale-token gap, deviations.md).
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §8, §9.

begin;
select plan(70);

-- ── fixtures (as the migration role: RLS bypassed, no claims) ─────────────────────────
-- Tenant A is the launch tenant (the one anon is fenced to); tenant B is another. Every
-- fixture id starts 7a000000- so the seeded FAQ rows never enter a count.
insert into public.tenants (id, name) values ('7a000000-0000-4000-8000-00000000000b', 'FaqOther');
insert into public.faq_items (id, tenant_id, question, answer, status, sort_order, scheduled_for, updated_at) values
  ('7a000000-0000-4000-8000-000000000001', app.default_tenant_id(),
   '{"en":"Published?","ar":"منشور؟"}', '{"en":"Yes.","ar":"نعم."}', 'published', 10, null, now() - interval '1 day'),
  ('7a000000-0000-4000-8000-000000000002', app.default_tenant_id(),
   '{"en":"Draft?","ar":"مسودة؟"}', '{"en":"Yes.","ar":"نعم."}', 'draft', 20, null, now() - interval '1 day'),
  ('7a000000-0000-4000-8000-000000000003', app.default_tenant_id(),
   '{"en":"Scheduled?","ar":"مجدول؟"}', '{"en":"Yes.","ar":"نعم."}', 'scheduled', 30,
   now() - interval '1 minute', now() - interval '1 day'),
  ('7a000000-0000-4000-8000-000000000004', app.default_tenant_id(),
   '{"en":"Archived?","ar":"مؤرشف؟"}', '{"en":"Yes.","ar":"نعم."}', 'archived', 40, null, now() - interval '1 day'),
  ('7a000000-0000-4000-8000-0000000000b1', '7a000000-0000-4000-8000-00000000000b',
   '{"en":"Theirs?","ar":"لهم؟"}', '{"en":"Yes.","ar":"نعم."}', 'published', 10, null, now() - interval '1 day');

-- A caller: a role and a tenant (anon when p_role is null).
create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '7a000000-0000-4000-8000-0000000000f1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true)
$$;
create function _a() returns text language sql as $$ select app.default_tenant_id()::text $$;
-- The fixture rows of tenant A the caller reads.
create function _seen() returns int language sql as $$
  select count(*)::int from public.faq_items
   where id::text like '7a000000-%' and tenant_id = app.default_tenant_id()
$$;
create function _status(p_id text) returns text language sql as $$
  select status::text from public.faq_items where id = p_id::uuid
$$;
-- A statement as the CURRENT role: 'ok:<rows>', or its SQLSTATE.
create function _try(p_sql text) returns text language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return sqlstate;
end $$;

-- ── 1. The catalog ─────────────────────────────────────────────────────────────────────
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.faq_items'::regclass),
  'faq_items: RLS enabled and forced');
select is(
  (select string_agg(format('%s %s %s', policyname, cmd, permissive), ', ' order by policyname)
     from pg_policies where schemaname = 'public' and tablename = 'faq_items'),
  'faq_items_archive_admin UPDATE RESTRICTIVE, faq_items_delete_admin DELETE RESTRICTIVE, '
  'faq_items_read SELECT PERMISSIVE, faq_items_write ALL PERMISSIVE',
  'the policies are exactly the read, the write and the two Admin-only gates');
select is(
  (select coalesce(string_agg(policyname, ', '), '')
     from pg_policies
    where schemaname = 'public' and tablename = 'faq_items'
      and ((qual is not null and qual !~ '^\(\(?tenant_id = (app\.)?effective_tenant_id\(\)')
           or (with_check is not null and with_check !~ '^\(\(?tenant_id = (app\.)?effective_tenant_id\(\)'))),
  '',
  'every USING and WITH CHECK leads with the tenant predicate, the RESTRICTIVE pair included');
select is(
  (select string_agg(a.attname::text, ',' order by a.attname::text collate "C")
     from pg_attribute a
    where a.attrelid = 'public.faq_items'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('anon', a.attrelid, a.attnum, 'select')),
  'answer,id,question,sort_order,status,tenant_id',
  'anon SELECTs exactly six columns (never version, the schedule, the publish date or the actors)');
select ok(not has_table_privilege('anon', 'public.faq_items', 'select, insert, update, delete, truncate, references, trigger')
          and not has_any_column_privilege('anon', 'public.faq_items', 'insert, update, references'),
  'anon holds nothing else: no table privilege, no column write');
select ok(has_table_privilege('authenticated', 'public.faq_items', 'select')
          and has_table_privilege('authenticated', 'public.faq_items', 'insert')
          and has_table_privilege('authenticated', 'public.faq_items', 'update')
          and has_table_privilege('authenticated', 'public.faq_items', 'delete')
          and not has_table_privilege('authenticated', 'public.faq_items', 'truncate, references, trigger'),
  'authenticated: SELECT, INSERT, UPDATE, DELETE (RLS decides the rows), never TRUNCATE, REFERENCES, TRIGGER');
select ok(has_table_privilege('service_role', 'public.faq_items', 'select')
          and has_table_privilege('service_role', 'public.faq_items', 'insert')
          and has_table_privilege('service_role', 'public.faq_items', 'update')
          and has_table_privilege('service_role', 'public.faq_items', 'delete')
          and not has_table_privilege('service_role', 'public.faq_items', 'truncate, references, trigger'),
  'service_role: SELECT, INSERT, UPDATE, DELETE, never TRUNCATE (it fires no row trigger)');
select ok(not has_table_privilege('public', 'public.faq_items', 'select, insert, update, delete, truncate, references, trigger'),
  'PUBLIC holds nothing on faq_items');
select is(
  (select string_agg(format('%s %s', tgname, tgfoid::regprocedure), ', ' order by tgname collate "C")
     from pg_trigger where tgrelid = 'public.faq_items'::regclass and not tgisinternal),
  'faq_items__release_guard app.tg_release_guard(), faq_items_actor app.tg_set_actor(), '
  'faq_items_release_capture app.tg_release_capture(), faq_items_snapshot app.tg_snapshot_version(), '
  'faq_items_updated_at app.tg_set_updated_at(), faq_items_version app.tg_bump_version()',
  'the six triggers: the guard first, the stamps, history and the release capture');
select is(
  (select format('%s %s %s %s %s %s %s %s', e.table_name, e.key_column, e.area, e.author_roles,
                 e.delete_roles, e.columns, e.apply_order, e.has_status)
     from app.release_entities e where e.entity_type = 'faq_item'),
  'faq_items id collections {admin,content_creator} {admin} {question,answer,status,sort_order} 10 t',
  'the registry row: collections, authored by Admin and Content Creator, removed by Admin');
select ok(has_function_privilege('authenticated', 'app.faq_text_ok(jsonb, int)', 'execute')
          and has_function_privilege('service_role', 'app.faq_text_ok(jsonb, int)', 'execute')
          and not has_function_privilege('anon', 'app.faq_text_ok(jsonb, int)', 'execute'),
  'app.faq_text_ok: the writers may call it (a CHECK runs as the writer), anon may not');

-- ── 2. The CHECK (as the migration role: every path is held to it) ─────────────────────
select throws_ok($$ insert into public.faq_items (tenant_id, question, answer)
                    values (app.default_tenant_id(), '{"en":"Q"}', '{"en":"A","ar":"ج"}') $$,
  '23514', null, 'a question without its Arabic is refused');
select throws_ok($$ insert into public.faq_items (tenant_id, question, answer)
                    values (app.default_tenant_id(), '{"en":"","ar":"س"}', '{"en":"A","ar":"ج"}') $$,
  '23514', null, 'an empty question is refused');
select throws_ok($$ insert into public.faq_items (tenant_id, question, answer)
                    values (app.default_tenant_id(), jsonb_build_object('en', repeat('q', 201), 'ar', 'س'),
                            '{"en":"A","ar":"ج"}') $$,
  '23514', null, 'a 201-character question is refused');
select lives_ok($$ insert into public.faq_items (id, tenant_id, question, answer)
                   values ('7a000000-0000-4000-8000-0000000000c1', app.default_tenant_id(),
                           jsonb_build_object('en', repeat('q', 200), 'ar', 'س'),
                           jsonb_build_object('en', repeat('a', 1200), 'ar', 'ج')) $$,
  'a 200-character question and a 1200-character answer are accepted');
select throws_ok($$ insert into public.faq_items (tenant_id, question, answer)
                    values (app.default_tenant_id(), '{"en":"Q","ar":"س"}',
                            jsonb_build_object('en', repeat('a', 1201), 'ar', 'ج')) $$,
  '23514', null, 'a 1201-character answer is refused');
select throws_ok($$ insert into public.faq_items (tenant_id, question, answer)
                    values (app.default_tenant_id(), '{"en":"Q","ar":"س"}',
                            jsonb_build_object('en', E'One.\nTwo.', 'ar', 'ج')) $$,
  '23514', null, 'a newline in an answer is refused (the HTML would fold it, the JSON-LD keep it)');
select throws_ok($$ insert into public.faq_items (tenant_id, question, answer)
                    values (app.default_tenant_id(), '{"en":1,"ar":"س"}', '{"en":"A","ar":"ج"}') $$,
  '23514', null, 'a value that is not a string is refused');
select throws_ok($$ insert into public.faq_items (tenant_id, question, answer)
                    values (app.default_tenant_id(), '{"en":"Q","ar":"س","fr":"Q"}', '{"en":"A","ar":"ج"}') $$,
  '23514', null, 'an extra key is refused');
select throws_ok($$ insert into public.faq_items (tenant_id, question, answer)
                    values (app.default_tenant_id(), '{"en":" Q","ar":"س"}', '{"en":"A","ar":"ج"}') $$,
  '23514', null, 'a leading space is refused (the text is stored trimmed)');
select throws_ok($$ insert into public.faq_items (tenant_id, question, answer)
                    values (app.default_tenant_id(), '"Q"', '{"en":"A","ar":"ج"}') $$,
  '23514', null, 'a bare string is refused (an object of both languages)');
select lives_ok($$ insert into public.faq_items (id, tenant_id, question, answer)
                   values ('7a000000-0000-4000-8000-0000000000c2', app.default_tenant_id(),
                           '{"en":"Is 2 < 3 > 1?","ar":"هل 2 < 3؟"}', '{"en":"Yes, <b> is text.","ar":"نعم."}') $$,
  'angle brackets are allowed (rendered as text, escaped in the JSON-LD)');
delete from public.faq_items where id in ('7a000000-0000-4000-8000-0000000000c1', '7a000000-0000-4000-8000-0000000000c2');

-- ── 3. anon: the launch tenant's published rows, through the column grant ─────────────
set local role anon;
select _as(null, null);
select is(_seen(), 1, 'anon reads the published fixture only (not the draft, scheduled or archived)');
select is((select count(*)::int from public.faq_items where tenant_id = '7a000000-0000-4000-8000-00000000000b'),
  0, 'anon reads nothing of another tenant (the anon fence)');
select is((select question ->> 'en' from public.faq_items where id = '7a000000-0000-4000-8000-000000000001'),
  'Published?', 'anon reads the question and the answer');
select throws_ok($$ select version from public.faq_items $$, '42501', null,
  'anon CANNOT read the version (outside its column grant)');
select throws_ok($$ select * from public.faq_items $$, '42501', null,
  'anon CANNOT select * (the schedule and the actors are outside its grant)');
select is(_try($$ insert into public.faq_items (question, answer) values ('{"en":"Q","ar":"س"}', '{"en":"A","ar":"ج"}') $$),
  '42501', 'anon CANNOT insert');
select is(_try($$ update public.faq_items set sort_order = 99 $$), '42501', 'anon CANNOT update');
select is(_try($$ delete from public.faq_items $$), '42501', 'anon CANNOT delete');
reset role;

-- ── 4. Admin: everything, with the stamps and history ──────────────────────────────────
set local role authenticated;
select _as('admin', _a());
select is(_seen(), 4, 'admin reads all four fixtures, whatever their status');
select is(_try($$ insert into public.faq_items (id, tenant_id, question, answer)
                  values ('7a000000-0000-4000-8000-0000000000a1', app.default_tenant_id(),
                          '{"en":"New?","ar":"جديد؟"}', '{"en":"Yes.","ar":"نعم."}') $$),
  'ok:1', 'admin inserts a question (a draft by default)');
select is(_status('7a000000-0000-4000-8000-0000000000a1'), 'draft', 'a new question starts as a draft');
select is(_try($$ update public.faq_items set answer = '{"en":"Changed.","ar":"تغيّر."}'
                  where id = '7a000000-0000-4000-8000-000000000002' $$),
  'ok:1', 'admin updates an answer');
reset role;
select ok((select version = 2 and updated_by = '7a000000-0000-4000-8000-0000000000f1'
                  and updated_at > now() - interval '1 hour'
             from public.faq_items where id = '7a000000-0000-4000-8000-000000000002'),
  'the update bumped the version, named the actor and moved updated_at');
select is((select count(*)::int from public.content_versions
            where entity_type = 'faq_item' and entity_id = '7a000000-0000-4000-8000-000000000002'
              and version = 2),
  1, 'history keeps the change as a faq_item snapshot');
set local role authenticated;
select _as('admin', _a());
select is(_try($$ update public.faq_items set status = 'published' where id = '7a000000-0000-4000-8000-0000000000a1' $$),
  'ok:1', 'admin publishes');
select is(_try($$ update public.faq_items set status = 'archived' where id = '7a000000-0000-4000-8000-0000000000a1' $$),
  'ok:1', 'admin archives');
select is(_try($$ delete from public.faq_items where id = '7a000000-0000-4000-8000-0000000000a1' $$),
  'ok:1', 'admin deletes');

-- ── 5. Content Creator: writes and publishes; never archives or deletes ─────────────────
select _as('content_creator', _a());
select is(_seen(), 4, 'content_creator reads all four fixtures');
select is(_try($$ insert into public.faq_items (id, tenant_id, question, answer)
                  values ('7a000000-0000-4000-8000-0000000000c3', app.default_tenant_id(),
                          '{"en":"Mine?","ar":"لي؟"}', '{"en":"Yes.","ar":"نعم."}') $$),
  'ok:1', 'content_creator inserts');
select is(_try($$ update public.faq_items set sort_order = 15 where id = '7a000000-0000-4000-8000-0000000000c3' $$),
  'ok:1', 'content_creator updates');
select is(_try($$ update public.faq_items set status = 'published' where id = '7a000000-0000-4000-8000-0000000000c3' $$),
  'ok:1', 'content_creator publishes (content.publish)');
select is(_try($$ update public.faq_items set status = 'archived' where id = '7a000000-0000-4000-8000-0000000000c3' $$),
  '42501', 'content_creator CANNOT archive (RESTRICTIVE WITH CHECK, Admin only)');
select is(_try($$ delete from public.faq_items where id = '7a000000-0000-4000-8000-0000000000c3' $$),
  'ok:0', 'content_creator''s delete removes nothing (RESTRICTIVE, Admin only)');
reset role;
select is(_status('7a000000-0000-4000-8000-0000000000c3'), 'published', 'and the row is still there, published');
delete from public.faq_items where id = '7a000000-0000-4000-8000-0000000000c3';

-- ── 6. SEO and Developer: read, never write ──────────────────────────────────────────
set local role authenticated;
select _as('seo', _a());
select is(_seen(), 4, 'seo reads all four fixtures (staff read)');
select is(_try($$ insert into public.faq_items (question, answer) values ('{"en":"Q","ar":"س"}', '{"en":"A","ar":"ج"}') $$),
  '42501', 'seo CANNOT insert');
select is(_try($$ update public.faq_items set sort_order = 99 where id = '7a000000-0000-4000-8000-000000000001' $$),
  'ok:0', 'seo''s update changes nothing');
select is(_try($$ delete from public.faq_items where id = '7a000000-0000-4000-8000-000000000001' $$),
  'ok:0', 'seo''s delete removes nothing');
select _as('developer', _a());
select is(_seen(), 4, 'developer reads all four fixtures (staff read)');
select is(_try($$ insert into public.faq_items (question, answer) values ('{"en":"Q","ar":"س"}', '{"en":"A","ar":"ج"}') $$),
  '42501', 'developer CANNOT insert');
select is(_try($$ update public.faq_items set sort_order = 99 where id = '7a000000-0000-4000-8000-000000000001' $$),
  'ok:0', 'developer''s update changes nothing');
select is(_try($$ delete from public.faq_items where id = '7a000000-0000-4000-8000-000000000001' $$),
  'ok:0', 'developer''s delete removes nothing');

-- ── 7. Another tenant's Admin, and a token with no role ─────────────────────────────────
select _as('admin', '7a000000-0000-4000-8000-00000000000b');
select is(_seen(), 0, 'other_tenant admin reads none of tenant A''s rows');
select is((select count(*)::int from public.faq_items where id = '7a000000-0000-4000-8000-0000000000b1'),
  1, 'other_tenant admin reads its own row');
select is(_try($$ insert into public.faq_items (tenant_id, question, answer)
                  values (app.default_tenant_id(), '{"en":"Q","ar":"س"}', '{"en":"A","ar":"ج"}') $$),
  '42501', 'other_tenant admin CANNOT insert into tenant A');
select is(_try($$ update public.faq_items set sort_order = 99 where id = '7a000000-0000-4000-8000-000000000001' $$),
  'ok:0', 'other_tenant admin''s update of tenant A changes nothing');
select is(_try($$ delete from public.faq_items where id = '7a000000-0000-4000-8000-000000000001' $$),
  'ok:0', 'other_tenant admin''s delete of tenant A removes nothing');
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '7a000000-0000-4000-8000-0000000000f9')::text, true);
select is(_seen(), 1, 'a token with no role reads the published fixture only, as anon');
select is(_try($$ insert into public.faq_items (question, answer) values ('{"en":"Q","ar":"س"}', '{"en":"A","ar":"ج"}') $$),
  '42501', 'and writes nothing');
reset role;

-- ── 8. The scheduled publisher ───────────────────────────────────────────────────────────
select ok(app.publish_scheduled() >= 1, 'app.publish_scheduled() ran');
select is(_status('7a000000-0000-4000-8000-000000000003'), 'published', 'a due scheduled question is published');
select ok((select published_at is not null from public.faq_items where id = '7a000000-0000-4000-8000-000000000003'),
  'and stamped with its publish date');

-- ── 9. The release lane ──────────────────────────────────────────────────────────────────
-- Releases off (every tenant today): a write outside a release captures nothing.
select is((select count(*)::int from public.content_release_items where entity_type = 'faq_item'),
  0, 'releases off: no faq_item write so far was captured');
-- Tenant B switched on (inside this transaction only): staff meet the guard, and a write
-- with no switched role and no claim (the runbook, a seed) is one system item.
insert into app.release_tenants (tenant_id) values ('7a000000-0000-4000-8000-00000000000b');
set local role authenticated;
select _as('admin', '7a000000-0000-4000-8000-00000000000b');
select is(_try($$ update public.faq_items set sort_order = 11 where id = '7a000000-0000-4000-8000-0000000000b1' $$),
  '42501', 'releases on: an Admin''s live write is refused by the guard');
reset role;
select _as(null, null);
update public.faq_items set sort_order = 12 where id = '7a000000-0000-4000-8000-0000000000b1';
select is((select format('%s %s %s', op, release_id is null, after ->> 'sort_order')
             from public.content_release_items
            where entity_type = 'faq_item' and entity_id = '7a000000-0000-4000-8000-0000000000b1'),
  'update t 12', 'releases on: an out-of-band write is one system item (no release)');
select is((select count(*)::int from public.faq_items where id = '7a000000-0000-4000-8000-0000000000b1' and sort_order = 12),
  1, 'and the out-of-band write landed');
select is((select count(*)::int from public.content_release_items
            where entity_type = 'faq_item' and tenant_id = app.default_tenant_id()),
  0, 'tenant A (releases off) still captured nothing');


-- ── 10. The guide (H11's put in the same migration) ──────────────────────────────────────
-- Every tenant holds collections-and-faq: the launch tenant from the migration's put, tenant B
-- (made in this test, after the migration) from the tenants trigger seeding the catalog's set.
select is((select count(*)::int from public.tenants t
            where not exists (select 1 from public.help_articles h
                               where h.tenant_id = t.id and h.slug = 'collections-and-faq'
                                 and h.sort_order = 45 and '/admin/faq' = any (h.screens))),
  0, 'every tenant, one made after the migration included, holds the collections-and-faq guide');

select * from finish();
rollback;
