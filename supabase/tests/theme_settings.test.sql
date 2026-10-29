-- pgTAP: Theme v1 (Admin v2 E4, 0118). Run with `supabase test db`.
--
--   • custom_themes.settings and its CHECK: a v1 row holds the closed settings shape and the
--     tokens the Worker compiles from them (the closed key set, each value of its key's shape,
--     the colour tokens equal to the colours and present only when they are not the brand's,
--     every contrast pair of packages/theme/pairs.json passing; the motion tokens what the
--     motion settings say). A legacy row (no settings) is left alone.
--   • One v1 theme per tenant (a partial unique index).
--   • Who writes it (CLAUDE.md §5 "Theme editor"): Admin and Developer of the tenant; Content
--     Creator, SEO, a Sales token and another tenant's Admin change no row; anon has no write
--     at all (42501). Removal is Admin's only (0038's RESTRICTIVE delete gate).
--   • Who reads it: staff of the tenant; anon reads the ACTIVE v1 theme of the launch tenant,
--     and of it only `tokens` and `version` (42501 on any other column); never a legacy row,
--     an inactive theme, or another tenant's.
--   • The release registry stages `settings`; a save is history (the snapshot keeps it).
--   • The guides: theme (new) and roles-and-access without "do not change the site yet".
-- No stale-token rows: no definer function or live check guards custom_themes (its writes are
-- the token's role, as 0001 left them).

begin;
select plan(32);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values ('e4000000-0000-0000-0000-0000000000ff', 'T-E4');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', 'e4000000-0000-0000-0000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- A passing v1 theme: black primary, warm grey hover and accent, the marquee slower and no
-- reveal (packages/theme/compile.ts compileTheme of these settings).
create function _settings() returns jsonb language sql as $$
  select '{"v":1,"mode":"advanced","colors":{"primary":"#000000","hover":"#615757","accent":"#938A8D"},"motion":{"marquee":"slower","reveal":false}}'::jsonb
$$;
create function _tokens() returns jsonb language sql as $$
  select '{"--bs-klein":"#000000","--bs-cobalt":"#615757","--bs-sky":"#938a8d","--bs-sky-soft":"#c3bdbf","--bs-glow-klein":"rgba(0, 0, 0, 0.42)","--bs-glow-sky":"rgba(147, 138, 141, 0.45)","--bs-shadow-klein":"0 12px 38px rgba(0, 0, 0, 0.45)","--bs-shadow-cobalt":"0 18px 48px rgba(97, 87, 87, 0.45)","--bs-marquee-scale":"1.5","--bs-rv-from":"1","--bs-rv-shift":"0px"}'::jsonb
$$;

-- A legacy theme (no settings), active, with a free-form token: never served.
insert into public.custom_themes (id, tenant_id, name, tokens, is_active) values
  ('e4000000-0000-0000-0000-00000000c001', app.default_tenant_id(), 'Legacy',
   '{"--x":"red"}', true);
-- Another tenant's active v1 theme.
insert into public.custom_themes (id, tenant_id, name, settings, tokens, is_active) values
  ('e4000000-0000-0000-0000-00000000c0ff', 'e4000000-0000-0000-0000-0000000000ff', 'Other',
   _settings(), _tokens(), true);

-- How many themes the CURRENT role renamed.
create function _rename(p_id uuid, p_name text) returns int language plpgsql as $$
declare n int;
begin
  update public.custom_themes set name = p_name where id = p_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- How many themes the CURRENT role removed.
create function _remove(p_id uuid) returns int language plpgsql as $$
declare n int;
begin
  delete from public.custom_themes where id = p_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---- the column ----------------------------------------------------------------------------
select ok(exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'custom_themes'
                     and column_name = 'settings' and data_type = 'jsonb' and is_nullable = 'YES'),
  'custom_themes.settings is a nullable jsonb column');

-- ---- who writes it -------------------------------------------------------------------------
set local role authenticated;
select _as('admin', app.default_tenant_id()::text);
select lives_ok($$ insert into public.custom_themes (id, name, settings, tokens, is_active)
                   values ('e4000000-0000-0000-0000-00000000c002', 'Site theme', _settings(),
                           _tokens(), true) $$,
  'admin saves a v1 theme that passes the gate');
select throws_ok($$ insert into public.custom_themes (name, settings, tokens, is_active)
                    values ('Second', _settings(), _tokens(), false) $$,
  '23505', null, 'a second v1 theme in the tenant is refused (one per tenant)');
select _as('developer', app.default_tenant_id()::text);
select is(_rename('e4000000-0000-0000-0000-00000000c002', 'Site theme (dev)'), 1,
  'developer changes the theme (theme.edit)');
select _as('content_creator', app.default_tenant_id()::text);
select is(_rename('e4000000-0000-0000-0000-00000000c002', 'By CC'), 0,
  'content_creator changes no theme');
select _as('seo', app.default_tenant_id()::text);
select is(_rename('e4000000-0000-0000-0000-00000000c002', 'By SEO'), 0, 'seo changes no theme');
select _as('sales', app.default_tenant_id()::text);
select is(_rename('e4000000-0000-0000-0000-00000000c002', 'By sales'), 0,
  'a sales token changes no theme');
select _as('admin', 'e4000000-0000-0000-0000-0000000000ff');
select is(_rename('e4000000-0000-0000-0000-00000000c002', 'By another tenant'), 0,
  'another tenant''s admin changes no theme of T1');
select _as('developer', app.default_tenant_id()::text);
select is(_remove('e4000000-0000-0000-0000-00000000c001'), 0,
  'developer removes no theme (removal is Admin''s, 0038)');

-- ---- the rule (the CHECK), as the admin ------------------------------------------------------
select _as('admin', app.default_tenant_id()::text);
select throws_ok($$ update public.custom_themes
                      set settings = jsonb_set(_settings(), '{colors,hover}', '"#7FB2FF"'),
                          tokens = jsonb_set(_tokens(), '{--bs-cobalt}', '"#7fb2ff"')
                    where id = 'e4000000-0000-0000-0000-00000000c002' $$,
  '23514', null, 'a hover white text cannot be read on is refused (the contrast pairs)');
select throws_ok($$ update public.custom_themes
                      set tokens = jsonb_set(_tokens(), '{--bs-klein}', '"#0024bc"')
                    where id = 'e4000000-0000-0000-0000-00000000c002' $$,
  '23514', null, 'tokens that are not the settings'' colours are refused');
select throws_ok($$ update public.custom_themes
                      set tokens = _tokens() || '{"--bs-fg":"red"}'
                    where id = 'e4000000-0000-0000-0000-00000000c002' $$,
  '23514', null, 'a token outside the closed set is refused');
select throws_ok($$ update public.custom_themes
                      set tokens = jsonb_set(_tokens(), '{--bs-glow-sky}', '"red; } body { display:none"')
                    where id = 'e4000000-0000-0000-0000-00000000c002' $$,
  '23514', null, 'a token value that could break out of its declaration is refused');
select throws_ok($$ update public.custom_themes
                      set tokens = _tokens() - '--bs-marquee-scale'
                    where id = 'e4000000-0000-0000-0000-00000000c002' $$,
  '23514', null, 'motion tokens that are not the motion settings are refused');
select throws_ok($$ update public.custom_themes
                      set settings = _settings() || '{"customCss":"body{}"}'
                    where id = 'e4000000-0000-0000-0000-00000000c002' $$,
  '23514', null, 'a settings key outside the v1 shape is refused');
select lives_ok($$ update public.custom_themes
                     set settings = '{"v":1,"mode":"simple","colors":{"primary":"#0024BC","hover":"#024CFF","accent":"#22A9FF"},"motion":{"marquee":"normal","reveal":true}}',
                         tokens = '{}'
                   where id = 'e4000000-0000-0000-0000-00000000c002' $$,
  'the brand defaults with no token are taken (Reset to brand defaults)');
select lives_ok($$ update public.custom_themes set settings = _settings(), tokens = _tokens()
                   where id = 'e4000000-0000-0000-0000-00000000c002' $$,
  'and the theme can be saved again');
select lives_ok($$ update public.custom_themes set tokens = '{"--y":"anything"}'
                   where id = 'e4000000-0000-0000-0000-00000000c001' $$,
  'a legacy row (no settings) is left to its old rules');

-- ---- who reads it ----------------------------------------------------------------------------
select is((select count(*)::int from public.custom_themes), 2,
  'staff read their tenant''s themes, legacy included');
set local role anon;
select _as(null, null);
select is((select tokens from public.custom_themes), _tokens(),
  'anon reads the active v1 theme''s tokens (the launch tenant''s only)');
select ok((select version from public.custom_themes) >= 1, 'and its version');
select throws_ok($$ select settings from public.custom_themes $$, '42501', null,
  'anon cannot read the settings');
select throws_ok($$ select name, is_active from public.custom_themes $$, '42501', null,
  'nor the name or whether a theme is active');
select throws_ok($$ update public.custom_themes set tokens = '{}' $$, '42501', null,
  'anon cannot write a theme');
reset role;
update public.custom_themes set is_active = false where id = 'e4000000-0000-0000-0000-00000000c002';
set local role anon;
select _as(null, null);
select is((select count(*)::int from public.custom_themes), 0,
  'an inactive theme is not served, and neither is the active legacy one');
reset role;
select _as(null, null);

-- ---- removal, history, the registry, the guides (as the migration role, then the admin) ------
set local role authenticated;
select _as('admin', app.default_tenant_id()::text);
select is(_remove('e4000000-0000-0000-0000-00000000c001'), 1,
  'admin removes a theme');
reset role;
select _as(null, null);
select ok(exists (select 1 from public.content_versions
                   where entity_type = 'custom_theme'
                     and entity_id = 'e4000000-0000-0000-0000-00000000c002'
                     and snapshot -> 'settings' = _settings()),
  'a saved theme is history: the snapshot keeps its settings');
select is((select columns from app.release_entities where entity_type = 'custom_theme'),
  array['name', 'tokens', 'is_active', 'settings'],
  'the release registry stages the settings: custom_theme''s columns end with settings');
select ok(exists (select 1 from pg_trigger
                   where tgrelid = 'public.custom_themes'::regclass
                     and tgname = 'custom_themes__release_guard'),
  'the release guard stays on custom_themes');
select ok(exists (select 1 from app.help_guide_catalog
                   where slug = 'theme' and revision >= 1 and sort_order = 97
                     and caps = array['theme.edit'] and screens = array['/admin/appearance/theme']),
  'the catalog holds the theme guide for the theme editor, place 97');
select is((select count(*)::int from public.help_articles
            where tenant_id = 'e4000000-0000-0000-0000-0000000000ff' and slug = 'theme'), 1,
  'a tenant made after the migration gets the theme guide too (the tenants trigger)');
select is((select count(*)::int from public.help_articles
            where slug = 'roles-and-access' and body::text like '%do not change the site yet%'), 0,
  'no tenant''s roles guide says saved themes do not change the site');

select * from finish();
rollback;
