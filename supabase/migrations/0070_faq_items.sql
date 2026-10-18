-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0070 — The FAQ moves into the database: public.faq_items (Admin v2 U7, slice U7a of the
-- folded U7 PR). Forward-only and EXPAND only: one new table, one new CHECK helper, the
-- scheduled publisher restated with the table added. Nothing that exists changes shape.
-- Depends on 0001 (tenants, content_status), 0009 (app.tg_bump_version), 0011 (the grant
-- regime), 0021 (the status-entity policy pattern), 0038 (the release registry, history),
-- 0051 (app.tg_release_capture) and 0066 (the release guard, app.publish_scheduled as R5
-- left it).
--
-- The design is docs/admin-v2/ui.md "Collections (AV-16)" and "### AV-16", releases.md §1.1
-- (the faq_item row) and §2.6, and verification.md's FAQ cutover; the decisions taken and
-- every departure are in docs/admin-v2/as-built/U7.md.
--
--   1. app.faq_text_ok(jsonb, int): the shape of a question or an answer. Exactly
--      {"en": text, "ar": text}, each 1 to p_max characters, already trimmed, and free of
--      C0/C1 control characters. That refuses a newline on purpose: the band's HTML folds a
--      newline that the FAQPage JSON-LD would keep, a visible/structured mismatch. `<` and
--      `>` are allowed (rendered as text, escaped in the JSON-LD).
--   2. public.faq_items: bilingual question and answer, status lifecycle, schedule, order,
--      version, actors. No slug: an item is never addressed by URL.
--   3. RLS, ENABLE + FORCE, the status-entity pattern of 0021 with the tenant predicate
--      FIRST in every USING and every WITH CHECK, the RESTRICTIVE pair included: anon and
--      every other reader see published rows; staff (app.is_staff) see all of their tenant's;
--      Admin and Content Creator write (app.can_write_content = the holders of pages.write
--      and content.publish); only an Admin archives or deletes (content.archiveDelete).
--   4. Grants, stated for both Supabase grant regimes (P-14): anon SELECTs six columns
--      (never the version, the schedule, the publish date, the actors or the stamps);
--      authenticated and service_role SELECT, INSERT, UPDATE, DELETE; nothing else, no
--      TRUNCATE, REFERENCES or TRIGGER for anyone. No sequence (uuid key).
--   5. Triggers, BEFORE ones in the order their names sort: the release guard
--      (`faq_items__release_guard`, as 0066's loop gives every registry table), the actor,
--      updated_at and the version; AFTER: the history snapshot ('faq_item') and the release
--      capture.
--   6. The release registry row (registry contract #4): staged once releases switch on (P-3).
--   7. app.publish_scheduled() restated: 0066's body with faq_items added (D16), skipping a
--      tenant with releases on exactly as 0066 does.
--   8. THE HELP GUIDE: not here yet (see the TODO in section 8). H11's catalog gives
--      app.put_help_guide(jsonb); this slice's guide is docs/admin-v2/guides/
--      collections-and-faq.json and is wired with one call once H11 is on main.
--
-- No live check (app.live_role) on faq_items: public content, no PII, the same posture as
-- every content table; a demoted token's last hour is the general stale-token gap
-- (deviations.md), unchanged here. No new capability, no app.role_* helper (pages.write is
-- app.can_write_content), no ROLE_CAPS or §5 change.
--
-- The content is NOT seeded here: content belongs to editors, and migrations seed only
-- code-owned data. supabase/seed-data/56-faq.json seeds it (published, never a placeholder)
-- and production takes it as a delta seed BEFORE the PR that removes the code copy merges
-- (launch runbook §6, the FAQ cutover).
--
-- CLAUDE.md §3 (Pillar 1, Pillar 3, Pillar 4), §8 (Admin v2 lanes, UI), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later.
-- Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. The shape of one question or answer ═════════════════════════════════════════════
-- `language sql immutable` (a CHECK needs an immutable expression). The keys are exactly
-- en and ar, both strings, each 1 to p_max characters, equal to its own trim (btrim's
-- spaces; the Worker's schema trims every Unicode space first), and no C0/C1 control
-- character (\u0001-\u001F, \u007F-\u009F: named, not a locale's [[:cntrl:]]).
create or replace function app.faq_text_ok(p jsonb, p_max int) returns boolean
  language sql immutable set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_typeof(p) = 'object'
    and (select pg_catalog.array_agg(k order by k collate "C")
           from pg_catalog.jsonb_object_keys(p) as k) = array['ar', 'en']
    and pg_catalog.jsonb_typeof(p -> 'en') = 'string'
    and pg_catalog.jsonb_typeof(p -> 'ar') = 'string'
    and not exists (
      select 1
        from (values (p ->> 'en'), (p ->> 'ar')) as v(x)
       where pg_catalog.char_length(v.x) not between 1 and p_max
          or v.x <> pg_catalog.btrim(v.x)
          or v.x ~ '[\u0001-\u001F\u007F-\u009F]'),
    false)
$$;
-- A CHECK runs with the writer's privileges: the two roles that write may call it; anon
-- never writes.
revoke all on function app.faq_text_ok(jsonb, int) from public, anon, authenticated, service_role;
grant execute on function app.faq_text_ok(jsonb, int) to authenticated, service_role;

-- ═══ 2. The table ═════════════════════════════════════════════════════════════════════════
create table if not exists public.faq_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id()
    references public.tenants (id) on delete cascade,
  question jsonb not null,
  answer jsonb not null,
  status content_status not null default 'draft',
  published_at timestamptz,
  scheduled_for timestamptz,
  sort_order int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint faq_items_question_shape check (app.faq_text_ok(question, 200)),
  constraint faq_items_answer_shape check (app.faq_text_ok(answer, 1200))
);
-- The public read (published, in order) and the publisher's scan.
create index if not exists faq_items_tenant_status_idx
  on public.faq_items (tenant_id, status, sort_order);
create index if not exists faq_items_scheduled_idx
  on public.faq_items (tenant_id, scheduled_for) where status = 'scheduled';
alter table public.faq_items enable row level security;
alter table public.faq_items force row level security;
comment on table public.faq_items is
  'The FAQ (Admin v2 U7, 0070): bilingual plain-text questions and answers. One loader '
  '(src/lib/data/faq.ts getFaq) feeds both the Contact page''s FAQ band and its FAQPage '
  'JSON-LD, so the two never disagree.';

-- ═══ 3. Row security (the fence before any grant, 0011 §5) ═════════════════════════════
-- 0021's status-entity pattern, with the tenant predicate first everywhere (P-14; 0021's
-- archive gate leaves it out of its WITH CHECK, this one does not).
drop policy if exists faq_items_read on public.faq_items;
create policy faq_items_read on public.faq_items for select
  using (tenant_id = app.effective_tenant_id() and (status = 'published' or app.is_staff()));
drop policy if exists faq_items_write on public.faq_items;
create policy faq_items_write on public.faq_items for all
  using (tenant_id = app.effective_tenant_id() and app.can_write_content())
  with check (tenant_id = app.effective_tenant_id() and app.can_write_content());
drop policy if exists faq_items_delete_admin on public.faq_items;
create policy faq_items_delete_admin on public.faq_items as restrictive for delete
  using (tenant_id = app.effective_tenant_id() and app.is_admin());
drop policy if exists faq_items_archive_admin on public.faq_items;
create policy faq_items_archive_admin on public.faq_items as restrictive for update
  using (tenant_id = app.effective_tenant_id())
  with check (tenant_id = app.effective_tenant_id() and (app.is_admin() or status <> 'archived'));

-- ═══ 4. Grants (stated, never inherited: both grant regimes) ══════════════════════════════
revoke all on public.faq_items from public, anon, authenticated, service_role;
grant select (id, tenant_id, question, answer, sort_order, status) on public.faq_items to anon;
grant select, insert, update, delete on public.faq_items to authenticated;
-- The service role: R4's conflict lock reads and updates, the seeds and R17's restore insert
-- and delete. Never TRUNCATE (it fires no row trigger: neither the guard nor the capture
-- would see it, 0066).
grant select, insert, update, delete on public.faq_items to service_role;

-- ═══ 5. Triggers ═══════════════════════════════════════════════════════════════════════════
-- BEFORE row triggers fire in name order, so the guard (its double underscore sorts first)
-- refuses before any other BEFORE trigger's work runs, as 0066 gives every registry table.
drop trigger if exists faq_items__release_guard on public.faq_items;
create trigger faq_items__release_guard before insert or update or delete on public.faq_items
  for each row execute function app.tg_release_guard();
drop trigger if exists faq_items_actor on public.faq_items;
create trigger faq_items_actor before insert or update on public.faq_items
  for each row execute function app.tg_set_actor();
drop trigger if exists faq_items_updated_at on public.faq_items;
create trigger faq_items_updated_at before update on public.faq_items
  for each row execute function app.tg_set_updated_at();
drop trigger if exists faq_items_version on public.faq_items;
create trigger faq_items_version before update on public.faq_items
  for each row execute function app.tg_bump_version();
-- History, as every registry table but team_members keeps it (0038).
drop trigger if exists faq_items_snapshot on public.faq_items;
create trigger faq_items_snapshot after insert or update on public.faq_items
  for each row execute function app.tg_snapshot_version('faq_item');
-- What a release changes (0051), built as 0051's loop builds it: the generated columns read
-- from the catalog (none today, so the third argument is empty), so the call stays right if
-- one is ever added.
do $$
declare
  v_generated text;
begin
  select coalesce(string_agg(a.attname::text, ',' order by a.attnum), '') into v_generated
    from pg_attribute a
   where a.attrelid = 'public.faq_items'::regclass
     and a.attnum > 0 and not a.attisdropped and a.attgenerated = 's';
  execute 'drop trigger if exists faq_items_release_capture on public.faq_items';
  execute format('create trigger faq_items_release_capture after insert or update or delete '
                 'on public.faq_items for each row execute function '
                 'app.tg_release_capture(%L, %L, %L)', 'faq_item', 'id', v_generated);
end $$;

-- ═══ 6. The release registry ════════════════════════════════════════════════════════════
-- Registry contract #4 (releases.md §1.3): staged once releases switch on (P-3). Authors are
-- the holders of pages.write + content.publish, removals Admin's (content.archiveDelete).
-- published_at and scheduled_for stay out of the allowlist (R1). One row per line group,
-- parsed by tests/fixtures/releaseRegistry.ts: keep the shape.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('faq_item', 'faq_items', 'id', 'collections', '{admin,content_creator}', '{admin}',
   '{question,answer,status,sort_order}',
   '{}', '{}', '{}', 10, true, null)
on conflict (entity_type) do nothing;

-- ═══ 7. Scheduled publishing, with the FAQ ═══════════════════════════════════════════════
-- 0066's body (search_path '', every name qualified, a tenant with releases on skipped) with
-- 'faq_items' added: a scheduled question goes live by itself like any other content.
create or replace function app.publish_scheduled() returns int
  language plpgsql security definer set search_path = ''
as $$
declare
  n int := 0;
  c int;
  t text;
begin
  foreach t in array array['disciplines', 'services', 'blog_posts', 'portfolio', 'pages',
                           'testimonials', 'service_cases', 'faq_items'] loop
    begin
      -- testimonials: consent is already guaranteed: the CHECK refuses a scheduled row
      -- without it, unless it is a flagged sample (0028), which 0025 governs.
      execute pg_catalog.format(
        'update public.%I set status = ''published'', published_at = coalesce(published_at, pg_catalog.now())
          where status = ''scheduled'' and scheduled_for is not null and scheduled_for <= pg_catalog.now()
            and not app.releases_enabled(tenant_id)', t);
      get diagnostics c = row_count;
      n := n + c;
    exception when others then
      raise warning 'publish_scheduled: % skipped (%: %)', t, sqlstate, sqlerrm;
    end;
  end loop;
  return n;
end $$;
revoke all on function app.publish_scheduled() from public, anon, authenticated, service_role;

-- ═══ 8. The help guide ═══════════════════════════════════════════════════════════════════
-- TODO(H11): this slice's guide, collections-and-faq, is written but not seeded yet. H11's
-- catalog (app.put_help_guide(jsonb), one guide, every tenant) is landing first; once it is
-- on main, replace this comment with the one call below, its argument the JSON of
-- docs/admin-v2/guides/collections-and-faq.json as a dollar-quoted literal, and add the
-- guide's postcondition (every tenant holds collections-and-faq):
--   select app.put_help_guide($guide$ { ...docs/admin-v2/guides/collections-and-faq.json... } $guide$::jsonb);
-- Nobody restates app.help_article_set() any more (H11 retired that rule).

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
-- Each block says what it checks. Expressions are read as pg_get_expr prints them.
do $$
declare
  v_owner oid;
  v_bad text;
  v_want text[];
  v_got text[];
  v_tenant_first constant text :=
    '^\((\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND .+|tenant_id = (app\.)?effective_tenant_id\(\))\)$';
  r text;
  pr text;
begin
  select proowner into v_owner from pg_proc where oid = 'app.tg_snapshot_version()'::regprocedure;

  -- ---- 1. RLS enabled and forced --------------------------------------------------------
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.faq_items'::regclass) then
    raise exception '0070: public.faq_items is not ENABLE + FORCE row level security';
  end if;

  -- ---- 2. The exact policy set ----------------------------------------------------------
  v_want := array[
    'faq_items_archive_admin UPDATE RESTRICTIVE {public}',
    'faq_items_delete_admin DELETE RESTRICTIVE {public}',
    'faq_items_read SELECT PERMISSIVE {public}',
    'faq_items_write ALL PERMISSIVE {public}'];
  select array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles) order by policyname)
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'faq_items';
  if v_got is distinct from v_want then
    raise exception '0070: faq_items policies are %, expected %', v_got, v_want;
  end if;

  -- ---- 3. The tenant predicate is the first conjunct of every USING and WITH CHECK -------
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'faq_items'
     and ((qual is not null and qual !~ v_tenant_first)
          or (with_check is not null and with_check !~ v_tenant_first)
          or coalesce(qual, with_check) is null);
  if v_bad is not null then
    raise exception '0070: faq_items policies that do not lead with the tenant predicate: %', v_bad;
  end if;

  -- ---- 4. Privileges, exactly ---------------------------------------------------------------
  -- Table level: anon and PUBLIC nothing; authenticated and service_role exactly SELECT,
  -- INSERT, UPDATE, DELETE; nobody TRUNCATE, REFERENCES or TRIGGER (MAINTAIN on 17+).
  foreach r in array array['public', 'anon'] loop
    if has_table_privilege(r::name, 'public.faq_items',
                           'select, insert, update, delete, truncate, references, trigger')
       or (case when current_setting('server_version_num')::int >= 170000
                then has_table_privilege(r::name, 'public.faq_items', 'maintain')
                else false end) then
      raise exception '0070: % holds a table privilege on public.faq_items', r;
    end if;
  end loop;
  foreach r in array array['authenticated', 'service_role'] loop
    foreach pr in array array['select', 'insert', 'update', 'delete'] loop
      if not has_table_privilege(r::name, 'public.faq_items', pr) then
        raise exception '0070: % lacks % on public.faq_items', r, pr;
      end if;
    end loop;
    if has_table_privilege(r::name, 'public.faq_items', 'truncate, references, trigger')
       -- CASE, not AND: AND does not promise to short-circuit, and the privilege functions
       -- refuse the word MAINTAIN before PostgreSQL 17 (CI runs 15).
       or (case when current_setting('server_version_num')::int >= 170000
                then has_table_privilege(r::name, 'public.faq_items', 'maintain')
                else false end) then
      raise exception '0070: % holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on public.faq_items', r;
    end if;
  end loop;
  -- Column level: anon SELECTs exactly the six columns and nothing else (no INSERT, UPDATE
  -- or REFERENCES on any column); PUBLIC nothing; no column-level grant at all to
  -- authenticated or service_role (their access is the table grant).
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.faq_items'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', a.attrelid, a.attnum, 'select');
  if v_got is distinct from array['answer', 'id', 'question', 'sort_order', 'status', 'tenant_id'] then
    raise exception '0070: anon''s SELECT columns on faq_items are %', v_got;
  end if;
  if has_any_column_privilege('anon', 'public.faq_items', 'insert, update, references')
     or has_any_column_privilege('public', 'public.faq_items', 'select, insert, update, references') then
    raise exception '0070: anon or PUBLIC holds a column privilege beyond anon''s SELECT';
  end if;
  select string_agg(format('%s.%s', g.grantee::regrole, a.attname), ', ') into v_bad
    from pg_attribute a
    cross join lateral aclexplode(a.attacl) g
   where a.attrelid = 'public.faq_items'::regclass and a.attnum > 0 and not a.attisdropped
     and a.attacl is not null
     and g.grantee in ('authenticated'::regrole, 'service_role'::regrole);
  if v_bad is not null then
    raise exception '0070: column-level grants to authenticated or service_role: %', v_bad;
  end if;

  -- ---- 5. The triggers: exactly these six, with their functions and timing ----------------
  -- tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE.
  select array_agg(format('%s %s %s', t.tgname, t.tgtype, t.tgfoid::regprocedure)
                   order by t.tgname collate "C") into v_got
    from pg_trigger t
   where t.tgrelid = 'public.faq_items'::regclass and not t.tgisinternal and t.tgenabled = 'O';
  v_want := array[
    'faq_items__release_guard 31 app.tg_release_guard()',
    'faq_items_actor 23 app.tg_set_actor()',
    'faq_items_release_capture 29 app.tg_release_capture()',
    'faq_items_snapshot 21 app.tg_snapshot_version()',
    'faq_items_updated_at 19 app.tg_set_updated_at()',
    'faq_items_version 19 app.tg_bump_version()'];
  if v_got is distinct from v_want then
    raise exception '0070: faq_items triggers are %, expected %', v_got, v_want;
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.faq_items'::regclass and t.tgname = 'faq_items_snapshot'
                    and t.tgnargs = 1 and t.tgargs = convert_to('faq_item', 'UTF8') || '\x00'::bytea)
     or not exists (select 1 from pg_trigger t
                     where t.tgrelid = 'public.faq_items'::regclass
                       and t.tgname = 'faq_items_release_capture' and t.tgnargs = 3
                       and t.tgargs = convert_to('faq_item', 'UTF8') || '\x00'::bytea
                                      || convert_to('id', 'UTF8') || '\x00'::bytea
                                      || '\x00'::bytea) then
    raise exception '0070: the snapshot or the capture trigger has the wrong arguments';
  end if;

  -- ---- 6. The registry row, exactly, and its columns real ---------------------------------
  if not exists (select 1 from app.release_entities e
                  where e.entity_type = 'faq_item' and e.table_name = 'faq_items'
                    and e.key_column = 'id' and e.area = 'collections'
                    and e.author_roles = array['admin', 'content_creator']
                    and e.delete_roles = array['admin']
                    and e.columns = array['question', 'answer', 'status', 'sort_order']
                    and e.deferred_columns = '{}' and e.unique_flags = '{}'
                    and e.exempt_columns = '{}' and e.apply_order = 10 and e.has_status
                    and e.publish_flag is null) then
    raise exception '0070: the faq_item registry row is missing or differs';
  end if;
  select string_agg(c, ', ') into v_bad
    from app.release_entities e cross join unnest(e.columns) c
   where e.entity_type = 'faq_item'
     and not exists (select 1 from pg_attribute a
                      where a.attrelid = 'public.faq_items'::regclass and a.attname = c
                        and a.attnum > 0 and not a.attisdropped);
  if v_bad is not null then
    raise exception '0070: registry columns faq_items does not have: %', v_bad;
  end if;

  -- ---- 7. publish_scheduled: definer, search_path '', names faq_items, skips an armed
  -- tenant (0066's postcondition 8), and no API role may call it -------------------------
  if not exists (select 1 from pg_proc f
                  where f.oid = 'app.publish_scheduled()'::regprocedure and f.prosecdef
                    and f.proconfig = array['search_path=""']
                    and f.prosrc ~ '''faq_items'''
                    and f.prosrc ~ 'not app\.releases_enabled\(tenant_id\)') then
    raise exception '0070: app.publish_scheduled must be SECURITY DEFINER, search_path '''', name faq_items and skip armed tenants';
  end if;
  foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r::name, 'app.publish_scheduled()', 'execute') then
      raise exception '0070: % can execute app.publish_scheduled()', r;
    end if;
  end loop;

  -- ---- 8. app.faq_text_ok: IMMUTABLE, search_path '', authenticated and service_role only --
  if not exists (select 1 from pg_proc f
                  where f.oid = 'app.faq_text_ok(jsonb, integer)'::regprocedure
                    and f.provolatile = 'i' and not f.prosecdef
                    and f.proconfig = array['search_path=""']) then
    raise exception '0070: app.faq_text_ok must be IMMUTABLE, INVOKER, search_path ''''';
  end if;
  if not has_function_privilege('authenticated', 'app.faq_text_ok(jsonb, integer)', 'execute')
     or not has_function_privilege('service_role', 'app.faq_text_ok(jsonb, integer)', 'execute')
     or has_function_privilege('anon', 'app.faq_text_ok(jsonb, integer)', 'execute')
     or has_function_privilege('public', 'app.faq_text_ok(jsonb, integer)', 'execute') then
    raise exception '0070: app.faq_text_ok must be executable by authenticated and service_role only';
  end if;
  -- And it says what it means (a CHECK that admits everything would pass every test above).
  if not app.faq_text_ok('{"en":"Q","ar":"س"}', 200)
     or app.faq_text_ok('{"en":"Q"}', 200)
     or app.faq_text_ok('{"en":"Q","ar":"س","fr":"Q"}', 200)
     or app.faq_text_ok('{"en":"","ar":"س"}', 200)
     or app.faq_text_ok('{"en":" Q","ar":"س"}', 200)
     or app.faq_text_ok(jsonb_build_object('en', E'Q\nQ', 'ar', 'س'), 200)
     or app.faq_text_ok('{"en":1,"ar":"س"}', 200)
     or app.faq_text_ok(jsonb_build_object('en', repeat('q', 201), 'ar', 'س'), 200)
     or app.faq_text_ok('"Q"', 200) then
    raise exception '0070: app.faq_text_ok admits a shape it must refuse, or refuses a good one';
  end if;

  -- ---- 9. The release guard: on faq_items, first among its BEFORE row triggers, and still
  -- on every registry table (0066's postcondition 3 holds after this file) -----------------
  select string_agg(e.table_name, ', ' order by e.table_name) into v_bad
    from app.release_entities e
   where (select count(*) from pg_trigger tg
           where tg.tgrelid = format('public.%I', e.table_name)::regclass and not tg.tgisinternal
             and tg.tgfoid = 'app.tg_release_guard()'::regprocedure
             and tg.tgname = e.table_name || '__release_guard'
             and tg.tgtype = 31 and tg.tgenabled = 'O' and tg.tgnargs = 0) <> 1
      or (select tg.tgname from pg_trigger tg
           where tg.tgrelid = format('public.%I', e.table_name)::regclass and not tg.tgisinternal
             and tg.tgtype & 1 = 1 and tg.tgtype & 2 = 2
           order by tg.tgname collate "C" limit 1) is distinct from e.table_name || '__release_guard';
  if v_bad is not null then
    raise exception '0070: registry tables without exactly one guard firing first: %', v_bad;
  end if;

  -- ---- 10. Releases are still off everywhere (0038, 0051, 0062, 0066) ----------------------
  if exists (select 1 from app.release_tenants) then
    raise exception '0070: releases must stay switched off (app.release_tenants is not empty)';
  end if;
end $$;
