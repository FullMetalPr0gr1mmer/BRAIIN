-- pgTAP: the page editor's migration (Admin v2 E1, 0115). Run with `supabase test db`.
--
--   • page_sections.label: a nullable text column with no default, held by its CHECK to 1 to
--     60 characters, trimmed, with no control or format character (a newline, a bidi override
--     U+202E, a zero-width U+200B: Unicode Cc and Cf, the schema's class); null clears it.
--   • Who writes it (CLAUDE.md §5 "Pages & sections", §9): the table's own RLS, unchanged.
--     Admin and Content Creator rename a section of their tenant; SEO, Developer, a Sales
--     token and another tenant's Admin change no row; anon has no UPDATE at all (42501).
--   • Who reads it: staff of the tenant, and anon on a visible section of a published page
--     (0016's grant and fence: the verification accepted the column as public), never on a
--     hidden one.
--   • A rename is history like any other edit: the snapshot trigger keeps the label.
--   • The release registry stages it: page_section's columns end with `label`.
--   • editing-pages is in the catalog (revision 1, place 41) and in every tenant, a tenant made
--     after the migration included.
-- No stale-token rows: no definer function or live check guards page_sections (its writes are
-- the token's role, as every content table's).

begin;
select plan(30);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values ('e1000000-0000-0000-0000-0000000000ff', 'T-E1');

insert into public.pages (id, tenant_id, slug, title, status) values
  ('e1000000-0000-0000-0000-00000000a001', app.default_tenant_id(), 'e1-label-page',
   '{"en":"E1 page","ar":"صفحة"}', 'published');
insert into public.page_sections (id, tenant_id, page_id, type, content, visible, sort_order) values
  ('e1000000-0000-0000-0000-0000000051a1', app.default_tenant_id(),
   'e1000000-0000-0000-0000-00000000a001', 'slogan', '{}', true, 10),
  ('e1000000-0000-0000-0000-0000000051a2', app.default_tenant_id(),
   'e1000000-0000-0000-0000-00000000a001', 'cta', '{}', false, 20);

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', 'e1000000-0000-0000-0000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- How many sections the CURRENT role renamed to `p_label` (the visible fixture).
create function _rename(p_label text) returns int language plpgsql as $$
declare n int;
begin
  update public.page_sections set label = p_label
   where id = 'e1000000-0000-0000-0000-0000000051a1';
  get diagnostics n = row_count;
  return n;
end $$;

-- ---- the column ----------------------------------------------------------------------------
create function _label_col(p_what text) returns boolean language sql as $$
  select exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'page_sections'
                    and column_name = 'label'
                    and case p_what
                          when 'text' then data_type = 'text'
                          when 'nullable' then is_nullable = 'YES'
                          when 'no default' then column_default is null
                          else true end)
$$;
select ok(_label_col('exists'), 'page_sections has a label');
select ok(_label_col('text'), 'the label is text');
select ok(_label_col('nullable'), 'the label may be null (the type''s name)');
select ok(_label_col('no default'), 'the label has no default');

-- ---- who writes it -------------------------------------------------------------------------
set local role authenticated;
select _as('admin', app.default_tenant_id()::text);
select is(_rename('Slogan, under the hero'), 1, 'admin renames a section of the tenant');
select is((select label from public.page_sections where id = 'e1000000-0000-0000-0000-0000000051a1'),
  'Slogan, under the hero', 'and the label reads back');
select ok(exists (select 1 from public.content_versions
                   where entity_type = 'page_section'
                     and entity_id = 'e1000000-0000-0000-0000-0000000051a1'
                     and snapshot ->> 'label' = 'Slogan, under the hero'),
  'the rename is history: the snapshot keeps the label');

select _as('content_creator', app.default_tenant_id()::text);
select is(_rename('Slogan band'), 1, 'content_creator renames a section (pages.write)');

select _as('seo', app.default_tenant_id()::text);
select is(_rename('By SEO'), 0, 'seo changes no section (no pages.write)');
select _as('developer', app.default_tenant_id()::text);
select is(_rename('By developer'), 0, 'developer changes no section');
select _as('sales', app.default_tenant_id()::text);
select is(_rename('By sales'), 0, 'a sales token changes no section');
select _as('admin', 'e1000000-0000-0000-0000-0000000000ff');
select is(_rename('By another tenant'), 0, 'another tenant''s admin changes no section of T1');

-- ---- the rule (the CHECK), as the admin ------------------------------------------------------
select _as('admin', app.default_tenant_id()::text);
select throws_ok($$ select _rename('') $$, '23514', null, 'an empty label is refused');
select throws_ok($$ select _rename(' Hero') $$, '23514', null, 'an untrimmed label is refused');
select throws_ok($$ select _rename(repeat('a', 61)) $$, '23514', null,
  'a label of 61 characters is refused');
select throws_ok($$ select _rename(E'Two\nlines') $$, '23514', null,
  'a label with a line break is refused');
select throws_ok($$ select _rename(E'Hero\u202E band') $$, '23514', null,
  'a label with a bidi override (U+202E) is refused');
select throws_ok($$ select _rename(E'He\u200Bro') $$, '23514', null,
  'a label with a zero-width space (U+200B) is refused');
select throws_ok($$ select _rename(E'\u2066Hero\u2069') $$, '23514', null,
  'a label with a bidi isolate (U+2066, U+2069) is refused');
select is(_rename(repeat('a', 60)), 1, 'a label of 60 characters is taken');
select is(_rename('شريط الشعار'), 1, 'an Arabic label is taken');
select is(_rename(null), 1, 'null clears it (the type''s name shows)');
select is(_rename('Slogan band'), 1, 'and a name can be given again');

-- ---- who reads it ----------------------------------------------------------------------------
set local role anon;
select _as(null, null);
select is((select label from public.page_sections where id = 'e1000000-0000-0000-0000-0000000051a1'),
  'Slogan band', 'anon reads the label of a visible section of a published page (0016)');
select is((select count(*)::int from public.page_sections
            where id = 'e1000000-0000-0000-0000-0000000051a2'), 0,
  'anon reads no hidden section, its label included');
select throws_ok($$ update public.page_sections set label = 'anon' $$, '42501', null,
  'anon cannot write a label (no UPDATE grant)');

-- ---- the registry and the guide (as the migration role) ---------------------------------------
reset role;
select _as(null, null);
select is((select columns from app.release_entities where entity_type = 'page_section'),
  array['page_id', 'type', 'content', 'style', 'visible', 'sort_order', 'is_placeholder', 'label'],
  'the release registry stages a rename: page_section''s columns end with label');
select ok(exists (select 1 from app.help_guide_catalog
                   where slug = 'editing-pages' and revision >= 1 and sort_order = 41
                     and caps = array['pages.write'] and screens = array['/admin/pages']),
  'the catalog holds editing-pages for the page editor, place 41');
select is((select count(*)::int from public.help_articles
            where tenant_id = app.default_tenant_id() and slug = 'editing-pages'
              and title = 'Editing pages'), 1,
  'the launch tenant holds editing-pages');
select is((select count(*)::int from public.help_articles
            where tenant_id = 'e1000000-0000-0000-0000-0000000000ff' and slug = 'editing-pages'), 1,
  'a tenant made after the migration gets editing-pages too (the tenants trigger)');

select * from finish();
rollback;
