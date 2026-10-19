-- pgTAP: the leads guide rewritten for the leads screens (0065, Admin v2 C4b). Run with
-- `supabase test db`. What help_centre.test.sql proves for every guide (the RLS, the CHECKs,
-- the grants, the search) holds here unchanged; this file proves what 0065 itself changes:
--   1. the set still holds (at least) its 15 guides, and working-with-leads keeps its place, screens and
--      capability, in four minutes;
--   2. its text is the leads screens' own, in both languages (Move to…, not the old panel's
--      "Reveal contact details and notes");
--   3. a new tenant is seeded with it; a tenant holding the old text gets the new one with its
--      version moved once, and seeding again changes nothing;
--   4. the roles read it as every guide is read: staff of its tenant (the Worker decides which
--      guides each role is shown), never another tenant's admin, never anon.
--
-- Fixtures are two tenants of this file's own, each seeded by the tenants trigger (0046).

begin;
select plan(10);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('65000000-0000-4000-8000-00000000000a', 'LeadsGuideA'),
  ('65000000-0000-4000-8000-00000000000b', 'LeadsGuideB');

-- The rewritten guide as the set states it, read as the migration role (no API role may).
create function _guide() returns jsonb language sql security definer as $$
  select a from jsonb_array_elements(app.help_article_set()) a
   where a ->> 'slug' = 'working-with-leads'
$$;
create function _set_size() returns int language sql security definer as $$
  select jsonb_array_length(app.help_article_set())
$$;

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '65000000-0000-4000-8000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- ---- 1. the set ------------------------------------------------------------------------
-- At least 0065's fifteen: later slices add their own guides through app.put_help_guide
-- (0069, H11), and a count pinned here would make each of them edit this file.
select ok(_set_size() >= 15, 'the set still holds at least its 15 guides');
select ok(_guide() -> 'sort_order' = '70'::jsonb
          and _guide() -> 'minutes' = '4'::jsonb
          and _guide() -> 'screens' = '["/admin/leads"]'::jsonb
          and _guide() -> 'caps' = '["leads.manage"]'::jsonb
          and _guide() ->> 'title' = 'Working with leads',
  'working-with-leads keeps its place, title, screens and capability, in four minutes');

-- ---- 2. the text -------------------------------------------------------------------------
select ok(position('Move to…' in (_guide() -> 'body' ->> 'en')) > 0
          and position('Reveal contact details and notes' in (_guide() -> 'body' ->> 'en')) = 0
          and position('Move to…' in (_guide() -> 'body' ->> 'ar')) > 0,
  'the text names the leads screens'' controls, in English and in Arabic');
select is(jsonb_array_length(_guide() -> 'body' -> 'en'),
          jsonb_array_length(_guide() -> 'body' -> 'ar'),
  'the Arabic follows the English block for block');

-- ---- 3. the seed ---------------------------------------------------------------------------
select ok(exists (select 1 from public.help_articles h
                   where h.tenant_id = '65000000-0000-4000-8000-00000000000a'
                     and h.slug = 'working-with-leads' and h.body = _guide() -> 'body'
                     and h.minutes = 4 and h.version = 1),
  'a new tenant is seeded with the rewritten guide, at version 1');

-- Tenant B as a tenant 0064 left: the guide holds an older text (the guard moves its version
-- to 2), then the seed brings the set's text back and moves it once more.
update public.help_articles
   set body = '{"en": [{"t": "p", "x": "The old text."}], "ar": [{"t": "p", "x": "النص القديم."}]}'::jsonb,
       minutes = 3
 where tenant_id = '65000000-0000-4000-8000-00000000000b' and slug = 'working-with-leads';
select app.seed_help_articles('65000000-0000-4000-8000-00000000000b');
select ok(exists (select 1 from public.help_articles h
                   where h.tenant_id = '65000000-0000-4000-8000-00000000000b'
                     and h.slug = 'working-with-leads' and h.body = _guide() -> 'body'
                     and h.minutes = 4 and h.version = 3),
  'a tenant holding the old text gets the new one, its version moved once by the seed');
select app.seed_help_articles('65000000-0000-4000-8000-00000000000b');
select is((select version from public.help_articles
            where tenant_id = '65000000-0000-4000-8000-00000000000b'
              and slug = 'working-with-leads'), 3,
  'seeding again changes nothing');

-- ---- 4. who reads it -----------------------------------------------------------------------
set local role authenticated;
select _as('developer', '65000000-0000-4000-8000-00000000000a');
select is((select count(*)::int from public.help_articles where slug = 'working-with-leads'), 1,
  'a developer reads its own tenant''s leads guide, and only that one');
select _as('admin', '65000000-0000-4000-8000-00000000000b');
select is((select count(*)::int from public.help_articles
            where slug = 'working-with-leads'
              and tenant_id = '65000000-0000-4000-8000-00000000000a'), 0,
  'another tenant''s admin reads none of this tenant''s guides');
reset role;

set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from public.help_articles where slug = 'working-with-leads' $$,
  '42501', null, 'anon cannot read the guide');
reset role;

select * from finish();
rollback;
