-- pgTAP: the font catalogue (Admin v2 E13). Run with `supabase test db`.
--
--   • custom_themes_theme_v1 (the CHECK, app.theme_row_ok restated by E13): a v3 row holds the
--     closed `fonts` {latin, arabic}, each one of the font catalogue's families for its script
--     (packages/theme/fonts.ts), and each font token is exactly what its choice writes: none
--     for the brand's (Archivo, Almarai). The catalogue holds only the brand's families until
--     owner item O-21, so no font token can be saved at all yet.
--   • A v1 (E4) and a v2 (E12) row are still taken as before, and carry no font token (rule 5:
--     the deployed editor saves v2 until the Worker is deployed).
--   • Who writes it is E4's (theme_settings.test.sql): Admin and Developer, live. Here the
--     admin writes, and the rules refuse with 23514.
--   • anon reads a v3 theme's tokens like any other.
--   • The guide `theme` is at revision 3 and names the Fonts card.

begin;
select plan(22);

insert into auth.users (id, email) values
  ('e1300000-0000-0000-0000-0000000000a1', 'e13-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('e1300000-0000-0000-0000-0000000000a1', app.default_tenant_id(), 'admin', true, null);

create function _as(p_role text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', 'e1300000-0000-0000-0000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role,
                                                   'tenant_id', app.default_tenant_id()))::text end,
    true
  )
$$;

-- The brand's colours and motion (no colour or motion token), as v1, v2 and v3 at the brand's
-- shapes, type and fonts.
create function _v1() returns jsonb language sql as $$
  select '{"v":1,"mode":"simple","colors":{"primary":"#0024BC","hover":"#024CFF","accent":"#22A9FF"},"motion":{"marquee":"normal","reveal":true}}'::jsonb
$$;
create function _v2() returns jsonb language sql as $$
  select _v1() || '{"v":2,"shapes":{"corners":"brand","buttons":"pill"},"type":{"headingWeight":800,"headingCase":"uppercase"}}'::jsonb
$$;
create function _v3() returns jsonb language sql as $$
  select _v2() || '{"v":3,"fonts":{"latin":"archivo","arabic":"almarai"}}'::jsonb
$$;
-- Archivo's stack, as global.css's :root holds it: the brand's, which no token ever writes.
create function _archivo_stack() returns text language sql as $$
  select $s$'Archivo', 'Archivo Fallback', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif$s$
$$;
create function _save(p_settings jsonb, p_tokens jsonb) returns void language sql as $$
  update public.custom_themes set settings = p_settings, tokens = p_tokens
   where id = 'e1300000-0000-0000-0000-00000000c001'
$$;

set local role authenticated;
select _as('admin');

-- ---- v3 at the brand's fonts; v1 and v2 still taken ------------------------------------------
select lives_ok($$ insert into public.custom_themes (id, name, settings, tokens, is_active)
                   values ('e1300000-0000-0000-0000-00000000c001', 'Site theme', _v3(), '{}', true) $$,
  'a v3 theme at the brand''s fonts writes no token');
select lives_ok($$ select _save(jsonb_set(jsonb_set(_v3(), '{shapes,buttons}', '"square"'),
                                          '{type,headingCase}', '"as-written"'),
                                '{"--bs-btn-radius":"0px","--bs-heading-case":"none"}') $$,
  'a v3 theme with shape and type choices: their tokens, and none for the fonts');
select lives_ok($$ select _save(jsonb_set(_v3(), '{motion,marquee}', '"slower"'),
                                '{"--bs-marquee-scale":"1.5"}') $$,
  'a v3 theme that slows the marquee');
select lives_ok($$ select _save(_v2(), '{}') $$,
  'a v2 theme (E12''s shape) is still saved: the deployed editor''s, until the deploy');
select lives_ok($$ select _save(_v1(), '{}') $$,
  'a v1 theme (E4''s shape) is still saved');

-- ---- refused: fonts off the catalogue, out of their version, or a token they do not write ---
select throws_ok($$ select _save(_v3() - 'fonts', '{}') $$,
  '23514', null, 'a v3 theme without its fonts is refused');
select throws_ok($$ select _save(_v2() || '{"fonts":{"latin":"archivo","arabic":"almarai"}}', '{}') $$,
  '23514', null, 'a v2 theme has no fonts (that is v3)');
select throws_ok($$ select _save(_v3() #- '{fonts,arabic}', '{}') $$,
  '23514', null, 'a v3 theme without its Arabic family is refused');
select throws_ok($$ select _save(jsonb_set(_v3(), '{fonts,heading}', '"archivo"'), '{}') $$,
  '23514', null, 'a fonts key outside the closed set is refused');
select throws_ok($$ select _save(jsonb_set(_v3(), '{fonts,latin}', '"inter"'), '{}') $$,
  '23514', null, 'a family outside the catalogue is refused (no Google font by name)');
select throws_ok($$ select _save(jsonb_set(_v3(), '{fonts,arabic}', '"archivo"'), '{}') $$,
  '23514', null, 'a family of the other script is refused');
select throws_ok($$ select _save(jsonb_set(_v3(), '{fonts,latin}', '1'), '{}') $$,
  '23514', null, 'a family written as a number is refused (a string, as the schema stores it)');
select throws_ok($$ select _save(_v3(), jsonb_build_object('--bs-font-sans', _archivo_stack())) $$,
  '23514', null, 'the brand''s own stack as a token is refused (the brand writes none)');
select throws_ok($$ select _save(_v3(), '{"--bs-font-ar":"serif"}') $$,
  '23514', null, 'a free font stack is refused (only a family of the catalogue)');
select throws_ok($$ select _save(_v3(), '{"--bs-font-sans":""}') $$,
  '23514', null, 'an empty font token is refused');
select throws_ok($$ select _save(_v3(), $t${"--bs-font-sans":"x;}body{display:none"}$t$::jsonb) $$,
  '23514', null, 'a value that could break out of its declaration is refused');
select throws_ok($$ select _save(_v2(), '{"--bs-font-sans":"serif"}') $$,
  '23514', null, 'a v2 theme carries no font token');
select throws_ok($$ select _save(_v1(), '{"--bs-font-ar":"serif"}') $$,
  '23514', null, 'a v1 theme carries no font token');
select throws_ok($$ select _save(jsonb_set(_v3(), '{v}', '4'), '{}') $$,
  '23514', null, 'a version after v3 is refused');

-- ---- anon reads a v3 theme's tokens like any other -------------------------------------------
select lives_ok($$ select _save(jsonb_set(_v3(), '{shapes,corners}', '"soft"'),
                                '{"--bs-radius-scale":"0.5"}') $$,
  'a v3 theme with soft corners');
reset role;
set local role anon;
select _as(null);
select is((select tokens from public.custom_themes), '{"--bs-radius-scale":"0.5"}'::jsonb,
  'anon reads the active v3 theme''s tokens (no font token: the brand''s fonts)');
reset role;
select _as(null);

-- ---- the guide ---------------------------------------------------------------------------------
select ok(exists (select 1 from app.help_guide_catalog
                   where slug = 'theme' and revision = 3 and sort_order = 97
                     and body::text like '%"Fonts"%'
                     and body::text like '%Shapes and type%'
                     and body::text not like '%the fonts are fixed%'),
  'the theme guide is at revision 3 and names the Fonts card');

select * from finish();
rollback;
