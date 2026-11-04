-- pgTAP: Theme v2, shapes and type (Admin v2 E12, AV-32). Run with `supabase test db`.
--
--   • custom_themes_theme_v1 (the CHECK, app.theme_row_ok restated by E12): a v2 row holds the
--     closed shapes {corners, buttons} and type {headingWeight, headingCase}, and each of the
--     four shape and type tokens is exactly what its choice writes (none for the brand's); a
--     v1 row (E4's) is still taken as E4 took it, and carries none of those tokens.
--   • Who writes it is E4's (theme_settings.test.sql): Admin and Developer, live. Here the
--     admin writes, and the rules refuse with 23514.
--   • anon reads the new tokens like the old (the column `tokens` of the active theme).
--   • The guide `theme` is at revision 2 or later (E13 put it again) and names the Shapes and
--     type cards.

begin;
select plan(20);

insert into auth.users (id, email) values
  ('e1200000-0000-0000-0000-0000000000a1', 'e12-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('e1200000-0000-0000-0000-0000000000a1', app.default_tenant_id(), 'admin', true, null);

create function _as(p_role text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', 'e1200000-0000-0000-0000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role,
                                                   'tenant_id', app.default_tenant_id()))::text end,
    true
  )
$$;

-- The brand's colours and motion (no colour or motion token), as v1 and as v2 at the brand's
-- shapes and type.
create function _v1() returns jsonb language sql as $$
  select '{"v":1,"mode":"simple","colors":{"primary":"#0024BC","hover":"#024CFF","accent":"#22A9FF"},"motion":{"marquee":"normal","reveal":true}}'::jsonb
$$;
create function _v2() returns jsonb language sql as $$
  select _v1() || '{"v":2,"shapes":{"corners":"brand","buttons":"pill"},"type":{"headingWeight":800,"headingCase":"uppercase"}}'::jsonb
$$;
-- Every shape and type choice away from the brand's, and the tokens packages/theme/compile.ts
-- writes for them (tests/fixtures/themedRun.json's shapes and type).
create function _themed() returns jsonb language sql as $$
  select jsonb_set(jsonb_set(jsonb_set(jsonb_set(_v2(),
           '{shapes,corners}', '"square"'), '{shapes,buttons}', '"square"'),
           '{type,headingWeight}', '700'), '{type,headingCase}', '"as-written"')
$$;
create function _themed_tokens() returns jsonb language sql as $$
  select '{"--bs-radius-scale":"0","--bs-btn-radius":"0px","--bs-heading-weight":"700","--bs-heading-case":"none"}'::jsonb
$$;
create function _save(p_settings jsonb, p_tokens jsonb) returns void language sql as $$
  update public.custom_themes set settings = p_settings, tokens = p_tokens
   where id = 'e1200000-0000-0000-0000-00000000c001'
$$;

set local role authenticated;
select _as('admin');

-- ---- v1 still taken; v2 at the brand's; each choice's own token ------------------------------
select lives_ok($$ insert into public.custom_themes (id, name, settings, tokens, is_active)
                   values ('e1200000-0000-0000-0000-00000000c001', 'Site theme', _v1(), '{}', true) $$,
  'a v1 theme (E4''s shape) is still saved');
select lives_ok($$ select _save(_v2(), '{}') $$,
  'a v2 theme at the brand''s shapes and type writes no token');
select lives_ok($$ select _save(_themed(), _themed_tokens()) $$,
  'square corners and buttons, bold headings as written: each with its one token');
select lives_ok($$ select _save(jsonb_set(jsonb_set(_v2(), '{shapes,corners}', '"round"'),
                                          '{shapes,buttons}', '"rounded"'),
                                '{"--bs-radius-scale":"1.5","--bs-btn-radius":"10px"}') $$,
  'round corners and rounded buttons');
select lives_ok($$ select _save(jsonb_set(_v2(), '{shapes,corners}', '"soft"'),
                                '{"--bs-radius-scale":"0.5"}') $$,
  'soft corners');

-- ---- refused: a token the settings do not say, a choice outside the list --------------------
select throws_ok($$ select _save(_v1(), '{"--bs-radius-scale":"0"}') $$,
  '23514', null, 'a v1 theme carries no shape or type token');
select throws_ok($$ select _save(_v1() || '{"shapes":{"corners":"square","buttons":"pill"}}', '{}') $$,
  '23514', null, 'a v1 theme has no shapes (that is v2)');
select throws_ok($$ select _save(_v2() - 'type', '{}') $$,
  '23514', null, 'a v2 theme without its type is refused');
select throws_ok($$ select _save(_themed(), '{}') $$,
  '23514', null, 'shape and type choices with no token are refused (the tokens are the settings)');
select throws_ok($$ select _save(_v2(), _themed_tokens()) $$,
  '23514', null, 'tokens at the brand''s shapes and type are refused');
select throws_ok($$ select _save(jsonb_set(_v2(), '{shapes,corners}', '"square"'),
                                 '{"--bs-radius-scale":"0.5"}') $$,
  '23514', null, 'a corner token that is another choice''s is refused');
select throws_ok($$ select _save(jsonb_set(_v2(), '{shapes,corners}', '"huge"'), '{}') $$,
  '23514', null, 'a corner choice outside the list is refused');
select throws_ok($$ select _save(jsonb_set(_v2(), '{type,headingWeight}', '900'), '{}') $$,
  '23514', null, 'a heading weight of 900 is refused (bold weights only: 700, 800)');
select throws_ok($$ select _save(jsonb_set(_v2(), '{type,headingWeight}', '"700"'),
                                 '{"--bs-heading-weight":"700"}') $$,
  '23514', null, 'a heading weight written as text is refused (a number, as the schema stores it)');
select throws_ok($$ select _save(_v2(), '{"--bs-btn-radius":"3px"}') $$,
  '23514', null, 'a button radius off the list is refused (closed token values)');
select throws_ok($$ select _save(_v2(), '{"--bs-heading-case":"uppercase; color: red"}') $$,
  '23514', null, 'a value that could break out of its declaration is refused');
select throws_ok($$ select _save(jsonb_set(_v2(), '{shapes,radius}', '4'), '{}') $$,
  '23514', null, 'a shapes key outside the closed set (the prototype''s free radius) is refused');

-- ---- anon reads the new tokens like the old ---------------------------------------------------
select lives_ok($$ select _save(_themed(), _themed_tokens()) $$, 'the themed save again');
reset role;
set local role anon;
select _as(null);
select is((select tokens from public.custom_themes), _themed_tokens(),
  'anon reads the active theme''s shape and type tokens');
reset role;
select _as(null);

-- ---- the guide ---------------------------------------------------------------------------------
select ok(exists (select 1 from app.help_guide_catalog
                   where slug = 'theme' and revision >= 2 and sort_order = 97
                     and body::text like '%Shapes and type%'
                     and body::text not like '%the shapes are fixed%'),
  'the theme guide is at revision 2 or later and names the Shapes and type cards');

select * from finish();
rollback;
