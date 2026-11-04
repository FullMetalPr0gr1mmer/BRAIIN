-- pgTAP: a stale token writes nothing (H16). Run with `supabase test db`.
--
-- RLS reads the role from the access token, which lives up to an hour. H16 puts a RESTRICTIVE
-- live check (app.live_role(), 0033) on every staff write of the 28 tables whose writes relied
-- on the token's role alone, and on public.update_media_meta. CLAUDE.md §9 (b).
--
-- Personas, each a token as PostgREST would carry it:
--   live      A admin, C content_creator, S seo, D developer, L sales, O another tenant's
--             admin, N anon (no claims, the anon role);
--   stale     for each staff role X of A C S D L: Xd demoted (the profile now holds another
--             role, the token the old one), Xo switched off, Xl locked.
-- For every one of the 28 tables, an UPDATE (a no-op on one fixture row), a DELETE (of that
-- row) and an INSERT (a copy of it) are tried by every persona, each attempt rolled back on
-- its own, and each answers as a word: the rows it touched, `x` refused (42501), `u` admitted
-- by RLS and stopped by the table's key (a singleton or a link pair copied onto itself).
--   • live: the writers write exactly what the JWT policies allow, unchanged by H16;
--   • stale: no stale token touches a row, with any command, on any table.
-- Then: each table carries exactly H16's three policies of the one shape; the rule that every
-- staff-writable table has a RESTRICTIVE live policy per command it can run holds, and it
-- catches a table that has none; the live role is read once per statement (an InitPlan), not
-- per row; update_media_meta refuses the stale tokens and still serves a live SEO.

begin;
select plan(186);

-- ── fixtures (as the migration role) ─────────────────────────────────────────────────────────
insert into public.tenants (id, name) values
  ('b1600000-0000-4000-8000-000000000001', 'T1'),
  ('b1600000-0000-4000-8000-0000000000ff', 'T2');

-- Personas: code, user id, the token's role, the token's tenant, the profile's role, active,
-- locked. N (anon) has no profile.
create table h16_persona (
  code text primary key, sub uuid, claim_role text, claim_tenant uuid,
  profile_role text, active boolean, locked boolean, ord int);
insert into h16_persona values
  ('A',  'b1600000-0000-4000-8000-0000000000a1', 'admin',           'b1600000-0000-4000-8000-000000000001', 'admin',           true,  false, 1),
  ('C',  'b1600000-0000-4000-8000-0000000000c1', 'content_creator', 'b1600000-0000-4000-8000-000000000001', 'content_creator', true,  false, 2),
  ('S',  'b1600000-0000-4000-8000-0000000000e1', 'seo',             'b1600000-0000-4000-8000-000000000001', 'seo',             true,  false, 3),
  ('D',  'b1600000-0000-4000-8000-0000000000d1', 'developer',       'b1600000-0000-4000-8000-000000000001', 'developer',       true,  false, 4),
  ('L',  'b1600000-0000-4000-8000-000000000051', 'sales',           'b1600000-0000-4000-8000-000000000001', 'sales',           true,  false, 5),
  ('O',  'b1600000-0000-4000-8000-0000000000f1', 'admin',           'b1600000-0000-4000-8000-0000000000ff', 'admin',           true,  false, 6),
  ('N',  null,                                   null,              null,                                   null,              null,  null,  7),
  ('Ad', 'b1600000-0000-4000-8000-0000000000a2', 'admin',           'b1600000-0000-4000-8000-000000000001', 'content_creator', true,  false, 11),
  ('Ao', 'b1600000-0000-4000-8000-0000000000a3', 'admin',           'b1600000-0000-4000-8000-000000000001', 'admin',           false, false, 12),
  ('Al', 'b1600000-0000-4000-8000-0000000000a4', 'admin',           'b1600000-0000-4000-8000-000000000001', 'admin',           true,  true,  13),
  ('Cd', 'b1600000-0000-4000-8000-0000000000c2', 'content_creator', 'b1600000-0000-4000-8000-000000000001', 'seo',             true,  false, 14),
  ('Co', 'b1600000-0000-4000-8000-0000000000c3', 'content_creator', 'b1600000-0000-4000-8000-000000000001', 'content_creator', false, false, 15),
  ('Cl', 'b1600000-0000-4000-8000-0000000000c4', 'content_creator', 'b1600000-0000-4000-8000-000000000001', 'content_creator', true,  true,  16),
  ('Sd', 'b1600000-0000-4000-8000-0000000000e2', 'seo',             'b1600000-0000-4000-8000-000000000001', 'sales',           true,  false, 17),
  ('So', 'b1600000-0000-4000-8000-0000000000e3', 'seo',             'b1600000-0000-4000-8000-000000000001', 'seo',             false, false, 18),
  ('Sl', 'b1600000-0000-4000-8000-0000000000e4', 'seo',             'b1600000-0000-4000-8000-000000000001', 'seo',             true,  true,  19),
  ('Dd', 'b1600000-0000-4000-8000-0000000000d2', 'developer',       'b1600000-0000-4000-8000-000000000001', 'sales',           true,  false, 20),
  ('Do', 'b1600000-0000-4000-8000-0000000000d3', 'developer',       'b1600000-0000-4000-8000-000000000001', 'developer',       false, false, 21),
  ('Dl', 'b1600000-0000-4000-8000-0000000000d4', 'developer',       'b1600000-0000-4000-8000-000000000001', 'developer',       true,  true,  22),
  ('Ld', 'b1600000-0000-4000-8000-000000000052', 'sales',           'b1600000-0000-4000-8000-000000000001', 'seo',             true,  false, 23),
  ('Lo', 'b1600000-0000-4000-8000-000000000053', 'sales',           'b1600000-0000-4000-8000-000000000001', 'sales',           false, false, 24),
  ('Ll', 'b1600000-0000-4000-8000-000000000054', 'sales',           'b1600000-0000-4000-8000-000000000001', 'sales',           true,  true,  25);

insert into auth.users (id, email)
  select sub, 'h16-' || lower(code) || '@example.test' from h16_persona where sub is not null;
insert into public.profiles (id, tenant_id, role, is_active, locked_until, display_name)
  select sub, claim_tenant, profile_role::app_role, active,
         case when locked then now() + interval '10 minutes' end, 'H16 ' || code
    from h16_persona where sub is not null;

-- One draft row per table in T1, plus what their keys point at. Fixed ids, so each attempt
-- names its row.
insert into public.pages (id, tenant_id, slug, title, status) values
  ('b1600000-0000-4000-8000-00000000aa01', 'b1600000-0000-4000-8000-000000000001', 'h16-page', '{"en":"P","ar":"ص"}', 'draft'),
  ('b1600000-0000-4000-8000-00000000aa02', 'b1600000-0000-4000-8000-000000000001', 'h16-page-two', '{"en":"P2","ar":"ص"}', 'draft');
insert into public.services (id, tenant_id, slug, title, status) values
  ('b1600000-0000-4000-8000-00000000ab01', 'b1600000-0000-4000-8000-000000000001', 'h16-service', '{"en":"S","ar":"خ"}', 'draft'),
  ('b1600000-0000-4000-8000-00000000ab02', 'b1600000-0000-4000-8000-000000000001', 'h16-service-two', '{"en":"S2","ar":"خ"}', 'draft');
insert into public.portfolio (id, tenant_id, slug, title, status) values
  ('b1600000-0000-4000-8000-00000000ac01', 'b1600000-0000-4000-8000-000000000001', 'h16-project', '{"en":"W","ar":"ع"}', 'draft');
insert into public.ai_config (tenant_id) values ('b1600000-0000-4000-8000-000000000001');
insert into public.ai_questions (id, tenant_id, slug, prompt, status) values
  ('b1600000-0000-4000-8000-00000000ad01', 'b1600000-0000-4000-8000-000000000001', 'h16-q', '{"en":"Q","ar":"س"}', 'draft');
insert into public.ai_styles (id, tenant_id, slug, name, status) values
  ('b1600000-0000-4000-8000-00000000ae01', 'b1600000-0000-4000-8000-000000000001', 'h16-style', '{"en":"St","ar":"ن"}', 'draft');
insert into public.audit_log (id, tenant_id, actor_id, actor_role, action) values
  (default, 'b1600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-0000000000a1', 'admin', 'h16.fixture');
insert into public.blog_posts (id, tenant_id, slug, title, status) values
  ('b1600000-0000-4000-8000-00000000af01', 'b1600000-0000-4000-8000-000000000001', 'h16-post', '{"en":"B","ar":"م"}', 'draft');
insert into public.categories (id, tenant_id, slug, name) values
  ('b1600000-0000-4000-8000-00000000b001', 'b1600000-0000-4000-8000-000000000001', 'h16-cat', '{"en":"K","ar":"ف"}');
insert into public.certifications (id, tenant_id, slug, name, status) values
  ('b1600000-0000-4000-8000-00000000b101', 'b1600000-0000-4000-8000-000000000001', 'h16-cert', '{"en":"Ce","ar":"ش"}', 'draft');
insert into public.clients (id, tenant_id, slug, name) values
  ('b1600000-0000-4000-8000-00000000b201', 'b1600000-0000-4000-8000-000000000001', 'h16-client', '{"en":"Cl","ar":"ع"}');
insert into public.disciplines (id, tenant_id, slug, name, status) values
  ('b1600000-0000-4000-8000-00000000b301', 'b1600000-0000-4000-8000-000000000001', 'h16-discipline', '{"en":"Di","ar":"ت"}', 'draft');
insert into public.entity_seo (id, tenant_id, entity_type, entity_id) values
  ('b1600000-0000-4000-8000-00000000b401', 'b1600000-0000-4000-8000-000000000001', 'page', 'b1600000-0000-4000-8000-00000000aa01');
insert into public.faq_items (id, tenant_id, question, answer, status) values
  ('b1600000-0000-4000-8000-00000000b501', 'b1600000-0000-4000-8000-000000000001', '{"en":"F?","ar":"س؟"}', '{"en":"F.","ar":"ج."}', 'draft');
insert into public.media_assets (id, tenant_id, kind, storage_path) values
  ('b1600000-0000-4000-8000-00000000b601', 'b1600000-0000-4000-8000-000000000001', 'image', 'https://images.example.test/h16.jpg'),
  -- The project's gallery picture, so the first stays unreferenced (deletable).
  ('b1600000-0000-4000-8000-00000000b602', 'b1600000-0000-4000-8000-000000000001', 'image', 'https://images.example.test/h16-gallery.jpg');
insert into public.navigation (id, tenant_id, location, label, href) values
  ('b1600000-0000-4000-8000-00000000b701', 'b1600000-0000-4000-8000-000000000001', 'header', '{"en":"N","ar":"ق"}', '/h16');
insert into public.page_sections (id, tenant_id, page_id, type) values
  ('b1600000-0000-4000-8000-00000000b801', 'b1600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000aa01', 'textBlock');
insert into public.partner_logos (id, tenant_id, name, logo_url) values
  ('b1600000-0000-4000-8000-00000000b901', 'b1600000-0000-4000-8000-000000000001', 'H16', 'https://images.example.test/h16-logo.png');
insert into public.portfolio_media (id, tenant_id, portfolio_id, role, kind, media_id) values
  ('b1600000-0000-4000-8000-00000000ba01', 'b1600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000ac01', 'gallery', 'image', 'b1600000-0000-4000-8000-00000000b602');
insert into public.portfolio_services (tenant_id, portfolio_id, service_id) values
  ('b1600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000ac01', 'b1600000-0000-4000-8000-00000000ab01');
insert into public.redirects (id, tenant_id, source_path, target_path) values
  ('b1600000-0000-4000-8000-00000000bb01', 'b1600000-0000-4000-8000-000000000001', '/h16-old', '/h16-new');
insert into public.sectors (id, tenant_id, slug, name) values
  ('b1600000-0000-4000-8000-00000000bc01', 'b1600000-0000-4000-8000-000000000001', 'h16-sector', '{"en":"Se","ar":"ق"}');
insert into public.seo_defaults (tenant_id) values ('b1600000-0000-4000-8000-000000000001');
insert into public.service_cases (id, tenant_id, service_id, title, status) values
  ('b1600000-0000-4000-8000-00000000bd01', 'b1600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000ab01', '{"en":"Ca","ar":"ح"}', 'draft');
insert into public.statistics (id, tenant_id, slug, label, value, status) values
  ('b1600000-0000-4000-8000-00000000be01', 'b1600000-0000-4000-8000-000000000001', 'h16-stat', '{"en":"St","ar":"إ"}', '1', 'draft');
insert into public.system_logs (tenant_id, level, message) values
  ('b1600000-0000-4000-8000-000000000001', 'info', 'h16 fixture');
insert into public.team_members (id, tenant_id, slug, name, status) values
  ('b1600000-0000-4000-8000-00000000c001', 'b1600000-0000-4000-8000-000000000001', 'h16-member', '{"en":"M","ar":"ع"}', 'draft');
insert into public.testimonials (id, tenant_id, slug, quote, author_name, status) values
  ('b1600000-0000-4000-8000-00000000c101', 'b1600000-0000-4000-8000-000000000001', 'h16-quote', '{"en":"Qu","ar":"ق"}', '{"en":"Au","ar":"ك"}', 'draft');

-- How each table's fixture row is named, and what its copy changes so the copy is a new row
-- (a fresh id comes from the column default: the copy never names `id`).
create table h16_target (t text primary key, key_sql text, copy_over jsonb, insert_sql text);
insert into h16_target (t, key_sql, copy_over, insert_sql) values
  ('ai_config',          $$tenant_id = 'b1600000-0000-4000-8000-000000000001'$$, '{}', null),
  ('ai_questions',       $$id = 'b1600000-0000-4000-8000-00000000ad01'$$, '{"slug":"h16-q-copy"}', null),
  ('ai_styles',          $$id = 'b1600000-0000-4000-8000-00000000ae01'$$, '{"slug":"h16-style-copy"}', null),
  ('audit_log',          $$action = 'h16.fixture' and tenant_id = 'b1600000-0000-4000-8000-000000000001'$$, '{}',
   -- Not a copy: staff write audit rows they cannot read back (the Worker's writeAudit). The
   -- actor and time are bound to the caller by audit_log_actor (0050).
   $$insert into public.audit_log (tenant_id, actor_id, actor_role, action)
     values ('b1600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-0000000000a1', 'admin', 'h16.attempt')$$),
  ('blog_posts',         $$id = 'b1600000-0000-4000-8000-00000000af01'$$, '{"slug":"h16-post-copy"}', null),
  ('categories',         $$id = 'b1600000-0000-4000-8000-00000000b001'$$, '{"slug":"h16-cat-copy"}', null),
  ('certifications',     $$id = 'b1600000-0000-4000-8000-00000000b101'$$, '{"slug":"h16-cert-copy"}', null),
  ('clients',            $$id = 'b1600000-0000-4000-8000-00000000b201'$$, '{"slug":"h16-client-copy"}', null),
  ('disciplines',        $$id = 'b1600000-0000-4000-8000-00000000b301'$$, '{"slug":"h16-discipline-copy"}', null),
  ('entity_seo',         $$id = 'b1600000-0000-4000-8000-00000000b401'$$, '{"entity_id":"b1600000-0000-4000-8000-00000000aa02"}', null),
  ('faq_items',          $$id = 'b1600000-0000-4000-8000-00000000b501'$$, '{}', null),
  ('media_assets',       $$id = 'b1600000-0000-4000-8000-00000000b601'$$, '{"storage_path":"https://images.example.test/h16-copy.jpg"}', null),
  ('navigation',         $$id = 'b1600000-0000-4000-8000-00000000b701'$$, '{}', null),
  ('page_sections',      $$id = 'b1600000-0000-4000-8000-00000000b801'$$, '{}', null),
  ('pages',              $$id = 'b1600000-0000-4000-8000-00000000aa01'$$, '{"slug":"h16-page-copy"}', null),
  ('partner_logos',      $$id = 'b1600000-0000-4000-8000-00000000b901'$$, '{}', null),
  ('portfolio',          $$id = 'b1600000-0000-4000-8000-00000000ac01'$$, '{"slug":"h16-project-copy"}', null),
  ('portfolio_media',    $$id = 'b1600000-0000-4000-8000-00000000ba01'$$, '{}', null),
  ('portfolio_services', $$portfolio_id = 'b1600000-0000-4000-8000-00000000ac01' and service_id = 'b1600000-0000-4000-8000-00000000ab01'$$, '{"service_id":"b1600000-0000-4000-8000-00000000ab02"}', null),
  ('redirects',          $$id = 'b1600000-0000-4000-8000-00000000bb01'$$, '{"source_path":"/h16-old-copy"}', null),
  ('sectors',            $$id = 'b1600000-0000-4000-8000-00000000bc01'$$, '{"slug":"h16-sector-copy"}', null),
  ('seo_defaults',       $$tenant_id = 'b1600000-0000-4000-8000-000000000001'$$, '{}', null),
  ('service_cases',      $$id = 'b1600000-0000-4000-8000-00000000bd01'$$, '{"service_id":"b1600000-0000-4000-8000-00000000ab02"}', null),
  ('services',           $$id = 'b1600000-0000-4000-8000-00000000ab01'$$, '{"slug":"h16-service-copy"}', null),
  ('statistics',         $$id = 'b1600000-0000-4000-8000-00000000be01'$$, '{"slug":"h16-stat-copy"}', null),
  ('system_logs',        $$message = 'h16 fixture' and tenant_id = 'b1600000-0000-4000-8000-000000000001'$$, '{}',
   -- Not a copy either: staff write log lines they cannot read back (system_logs_insert).
   $$insert into public.system_logs (tenant_id, level, message)
     values ('b1600000-0000-4000-8000-000000000001', 'info', 'h16 attempt')$$),
  ('team_members',       $$id = 'b1600000-0000-4000-8000-00000000c001'$$, '{"slug":"h16-member-copy"}', null),
  ('testimonials',       $$id = 'b1600000-0000-4000-8000-00000000c101'$$, '{"slug":"h16-quote-copy"}', null);

-- The statement each command runs on a table, as text (built here, as the migration role, so
-- the column list leaves out what an INSERT may not name: generated columns, identity columns
-- and a defaulted `id`).
create function h16_statement(p_t text, p_cmd text) returns text language plpgsql stable as $f$
declare
  v_key text;
  v_over jsonb;
  v_cols text;
  v_insert text;
begin
  select key_sql, copy_over, insert_sql into v_key, v_over, v_insert from h16_target where t = p_t;
  if p_cmd = 'update' then
    return format('update public.%I set tenant_id = tenant_id where %s', p_t, v_key);
  elsif p_cmd = 'delete' then
    return format('delete from public.%I where %s', p_t, v_key);
  elsif v_insert is not null then
    return v_insert;
  end if;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
    from pg_attribute a
   where a.attrelid = format('public.%I', p_t)::regclass
     and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''
     and not (a.attname = 'id' and a.atthasdef);
  return format(
    'insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I, '
    || '(select to_jsonb(f) || %3$L::jsonb from public.%1$I f where %4$s)) where exists '
    || '(select 1 from public.%1$I f where %4$s)',
    p_t, v_cols, v_over, v_key);
end $f$;

-- One attempt, as the CURRENT role, rolled back on its own: the rows it touched, `x` when it
-- was refused (42501: a missing grant, or a WITH CHECK that failed), `u` when RLS let it
-- through and the table's key stopped it. Any other error is the test's to see.
create function h16_try(p_sql text) returns text language plpgsql as $f$
declare
  n int;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
    raise exception using errcode = 'H1600', message = 'roll this attempt back';
  exception
    when sqlstate 'H1600' then return n::text;
    when insufficient_privilege then return 'x';
    when unique_violation then return 'u';
  end;
end $f$;
grant execute on function h16_try(text) to anon, authenticated;
-- The test's own tables: no API role writes them (Supabase's default privileges would grant
-- everything), and the loop below fetches its personas after switching roles.
revoke all on h16_persona, h16_target from public, anon, authenticated, service_role;
grant select on h16_persona to anon, authenticated;

-- Every persona of the list tries one statement: "A1 C0 …", in persona order.
create function h16_run(p_t text, p_cmd text, p_codes text[]) returns text language plpgsql as $f$
declare
  v_sql text := h16_statement(p_t, p_cmd);
  v_out text[] := '{}';
  p record;
  v_claims text;
begin
  for p in select * from h16_persona where code = any (p_codes) order by ord loop
    v_claims := case when p.claim_role is null then ''
                     else jsonb_build_object('sub', p.sub, 'role', 'authenticated',
                            'app_metadata', jsonb_build_object('role', p.claim_role,
                                                               'tenant_id', p.claim_tenant))::text end;
    perform set_config('request.jwt.claims', v_claims, true);
    if p.code = 'N' then
      set local role anon;
    else
      set local role authenticated;
    end if;
    v_out := v_out || (p.code || h16_try(v_sql));
    reset role;
  end loop;
  perform set_config('request.jwt.claims', '', true);
  return array_to_string(v_out, ' ');
end $f$;

-- The stale personas who touched a row (each answer that is neither 0 nor x), or ''.
create function h16_stale(p_t text, p_cmd text) returns text language sql as $$
  select coalesce(string_agg(w, ' '), '')
    from unnest(string_to_array(
           h16_run(p_t, p_cmd, array['Ad','Ao','Al','Cd','Co','Cl','Sd','So','Sl','Dd','Do','Dl','Ld','Lo','Ll']),
           ' ')) as w
   where substr(w, 3) not in ('0', 'x')
$$;

create function h16_live(p_t text, p_cmd text) returns text language sql as $$
  select h16_run(p_t, p_cmd, array['A','C','S','D','L','O','N'])
$$;

-- ── 1. the stale personas are what they say ────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-8000-0000000000a1","app_metadata":{"role":"admin","tenant_id":"b1600000-0000-4000-8000-000000000001"}}', true);
select is(app.live_role(), 'admin', 'a live Admin''s token has a live role');
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-8000-0000000000a2","app_metadata":{"role":"admin","tenant_id":"b1600000-0000-4000-8000-000000000001"}}', true);
select is(app.live_role(), null, 'a demoted Admin''s token has none');
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-8000-0000000000a3","app_metadata":{"role":"admin","tenant_id":"b1600000-0000-4000-8000-000000000001"}}', true);
select is(app.live_role(), null, 'nor a switched-off one''s');
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-8000-0000000000a4","app_metadata":{"role":"admin","tenant_id":"b1600000-0000-4000-8000-000000000001"}}', true);
select is(app.live_role(), null, 'nor a locked one''s');
select set_config('request.jwt.claims', '', true);
reset role;

-- ── 2. every table, every command, every persona ──────────────────────────────────────────
-- The live strings are what the JWT policies allowed before H16, unchanged (the same run without
-- 0129 answers them word for word, and there the stale tokens write). Unless a table says
-- otherwise: content, where Admin and Content Creator write and Admin alone deletes; a role that
-- can read a row but not write it is refused its copy (x), one that cannot read it copies nothing (0).
-- ai_config: ai.config: Admin alone; one row per tenant, so a copy meets the key (u).
select is(h16_live('ai_config', 'update'), 'A1 C0 S0 D0 L0 O0 Nx', 'ai_config: update, the live personas');
select is(h16_stale('ai_config', 'update'), '', 'ai_config: update, no stale token writes a row');
select is(h16_live('ai_config', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'ai_config: delete, the live personas');
select is(h16_stale('ai_config', 'delete'), '', 'ai_config: delete, no stale token writes a row');
select is(h16_live('ai_config', 'insert'), 'Au C0 S0 D0 L0 O0 Nx', 'ai_config: insert, the live personas');
select is(h16_stale('ai_config', 'insert'), '', 'ai_config: insert, no stale token writes a row');
select is(h16_live('ai_questions', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'ai_questions: update, the live personas');
select is(h16_stale('ai_questions', 'update'), '', 'ai_questions: update, no stale token writes a row');
select is(h16_live('ai_questions', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'ai_questions: delete, the live personas');
select is(h16_stale('ai_questions', 'delete'), '', 'ai_questions: delete, no stale token writes a row');
select is(h16_live('ai_questions', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'ai_questions: insert, the live personas');
select is(h16_stale('ai_questions', 'insert'), '', 'ai_questions: insert, no stale token writes a row');
select is(h16_live('ai_styles', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'ai_styles: update, the live personas');
select is(h16_stale('ai_styles', 'update'), '', 'ai_styles: update, no stale token writes a row');
select is(h16_live('ai_styles', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'ai_styles: delete, the live personas');
select is(h16_stale('ai_styles', 'delete'), '', 'ai_styles: delete, no stale token writes a row');
select is(h16_live('ai_styles', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'ai_styles: insert, the live personas');
select is(h16_stale('ai_styles', 'insert'), '', 'ai_styles: insert, no stale token writes a row');
-- audit_log: any member inserts a row naming itself; no API role updates or deletes.
select is(h16_live('audit_log', 'update'), 'Ax Cx Sx Dx Lx Ox Nx', 'audit_log: update, the live personas');
select is(h16_stale('audit_log', 'update'), '', 'audit_log: update, no stale token writes a row');
select is(h16_live('audit_log', 'delete'), 'Ax Cx Sx Dx Lx Ox Nx', 'audit_log: delete, the live personas');
select is(h16_stale('audit_log', 'delete'), '', 'audit_log: delete, no stale token writes a row');
select is(h16_live('audit_log', 'insert'), 'A1 C1 S1 D1 L1 Ox Nx', 'audit_log: insert, the live personas');
select is(h16_stale('audit_log', 'insert'), '', 'audit_log: insert, no stale token writes a row');
select is(h16_live('blog_posts', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'blog_posts: update, the live personas');
select is(h16_stale('blog_posts', 'update'), '', 'blog_posts: update, no stale token writes a row');
select is(h16_live('blog_posts', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'blog_posts: delete, the live personas');
select is(h16_stale('blog_posts', 'delete'), '', 'blog_posts: delete, no stale token writes a row');
select is(h16_live('blog_posts', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'blog_posts: insert, the live personas');
select is(h16_stale('blog_posts', 'insert'), '', 'blog_posts: insert, no stale token writes a row');
select is(h16_live('categories', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'categories: update, the live personas');
select is(h16_stale('categories', 'update'), '', 'categories: update, no stale token writes a row');
select is(h16_live('categories', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'categories: delete, the live personas');
select is(h16_stale('categories', 'delete'), '', 'categories: delete, no stale token writes a row');
select is(h16_live('categories', 'insert'), 'A1 C1 Sx Dx Lx O0 Nx', 'categories: insert, the live personas');
select is(h16_stale('categories', 'insert'), '', 'categories: insert, no stale token writes a row');
select is(h16_live('certifications', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'certifications: update, the live personas');
select is(h16_stale('certifications', 'update'), '', 'certifications: update, no stale token writes a row');
select is(h16_live('certifications', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'certifications: delete, the live personas');
select is(h16_stale('certifications', 'delete'), '', 'certifications: delete, no stale token writes a row');
select is(h16_live('certifications', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'certifications: insert, the live personas');
select is(h16_stale('certifications', 'insert'), '', 'certifications: insert, no stale token writes a row');
select is(h16_live('clients', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'clients: update, the live personas');
select is(h16_stale('clients', 'update'), '', 'clients: update, no stale token writes a row');
select is(h16_live('clients', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'clients: delete, the live personas');
select is(h16_stale('clients', 'delete'), '', 'clients: delete, no stale token writes a row');
select is(h16_live('clients', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'clients: insert, the live personas');
select is(h16_stale('clients', 'insert'), '', 'clients: insert, no stale token writes a row');
select is(h16_live('disciplines', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'disciplines: update, the live personas');
select is(h16_stale('disciplines', 'update'), '', 'disciplines: update, no stale token writes a row');
select is(h16_live('disciplines', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'disciplines: delete, the live personas');
select is(h16_stale('disciplines', 'delete'), '', 'disciplines: delete, no stale token writes a row');
select is(h16_live('disciplines', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'disciplines: insert, the live personas');
select is(h16_stale('disciplines', 'insert'), '', 'disciplines: insert, no stale token writes a row');
-- entity_seo: per-entity SEO: Admin and SEO.
select is(h16_live('entity_seo', 'update'), 'A1 C0 S1 D0 L0 O0 Nx', 'entity_seo: update, the live personas');
select is(h16_stale('entity_seo', 'update'), '', 'entity_seo: update, no stale token writes a row');
select is(h16_live('entity_seo', 'delete'), 'A1 C0 S1 D0 L0 O0 Nx', 'entity_seo: delete, the live personas');
select is(h16_stale('entity_seo', 'delete'), '', 'entity_seo: delete, no stale token writes a row');
select is(h16_live('entity_seo', 'insert'), 'A1 Cx S1 Dx L0 O0 Nx', 'entity_seo: insert, the live personas');
select is(h16_stale('entity_seo', 'insert'), '', 'entity_seo: insert, no stale token writes a row');
select is(h16_live('faq_items', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'faq_items: update, the live personas');
select is(h16_stale('faq_items', 'update'), '', 'faq_items: update, no stale token writes a row');
select is(h16_live('faq_items', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'faq_items: delete, the live personas');
select is(h16_stale('faq_items', 'delete'), '', 'faq_items: delete, no stale token writes a row');
select is(h16_live('faq_items', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'faq_items: insert, the live personas');
select is(h16_stale('faq_items', 'insert'), '', 'faq_items: insert, no stale token writes a row');
-- media_assets: media: Admin, Content Creator and Developer write, Admin hard-deletes.
select is(h16_live('media_assets', 'update'), 'A1 C1 S0 D1 L0 O0 Nx', 'media_assets: update, the live personas');
select is(h16_stale('media_assets', 'update'), '', 'media_assets: update, no stale token writes a row');
select is(h16_live('media_assets', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'media_assets: delete, the live personas');
select is(h16_stale('media_assets', 'delete'), '', 'media_assets: delete, no stale token writes a row');
select is(h16_live('media_assets', 'insert'), 'A1 C1 Sx D1 L0 O0 Nx', 'media_assets: insert, the live personas');
select is(h16_stale('media_assets', 'insert'), '', 'media_assets: insert, no stale token writes a row');
select is(h16_live('navigation', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'navigation: update, the live personas');
select is(h16_stale('navigation', 'update'), '', 'navigation: update, no stale token writes a row');
select is(h16_live('navigation', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'navigation: delete, the live personas');
select is(h16_stale('navigation', 'delete'), '', 'navigation: delete, no stale token writes a row');
select is(h16_live('navigation', 'insert'), 'A1 C1 Sx Dx Lx O0 Nx', 'navigation: insert, the live personas');
select is(h16_stale('navigation', 'insert'), '', 'navigation: insert, no stale token writes a row');
select is(h16_live('page_sections', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'page_sections: update, the live personas');
select is(h16_stale('page_sections', 'update'), '', 'page_sections: update, no stale token writes a row');
select is(h16_live('page_sections', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'page_sections: delete, the live personas');
select is(h16_stale('page_sections', 'delete'), '', 'page_sections: delete, no stale token writes a row');
select is(h16_live('page_sections', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'page_sections: insert, the live personas');
select is(h16_stale('page_sections', 'insert'), '', 'page_sections: insert, no stale token writes a row');
select is(h16_live('pages', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'pages: update, the live personas');
select is(h16_stale('pages', 'update'), '', 'pages: update, no stale token writes a row');
select is(h16_live('pages', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'pages: delete, the live personas');
select is(h16_stale('pages', 'delete'), '', 'pages: delete, no stale token writes a row');
select is(h16_live('pages', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'pages: insert, the live personas');
select is(h16_stale('pages', 'insert'), '', 'pages: insert, no stale token writes a row');
select is(h16_live('partner_logos', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'partner_logos: update, the live personas');
select is(h16_stale('partner_logos', 'update'), '', 'partner_logos: update, no stale token writes a row');
select is(h16_live('partner_logos', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'partner_logos: delete, the live personas');
select is(h16_stale('partner_logos', 'delete'), '', 'partner_logos: delete, no stale token writes a row');
select is(h16_live('partner_logos', 'insert'), 'A1 C1 Sx Dx Lx O0 Nx', 'partner_logos: insert, the live personas');
select is(h16_stale('partner_logos', 'insert'), '', 'partner_logos: insert, no stale token writes a row');
select is(h16_live('portfolio', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'portfolio: update, the live personas');
select is(h16_stale('portfolio', 'update'), '', 'portfolio: update, no stale token writes a row');
select is(h16_live('portfolio', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'portfolio: delete, the live personas');
select is(h16_stale('portfolio', 'delete'), '', 'portfolio: delete, no stale token writes a row');
select is(h16_live('portfolio', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'portfolio: insert, the live personas');
select is(h16_stale('portfolio', 'insert'), '', 'portfolio: insert, no stale token writes a row');
-- portfolio_media: a project's media links: whoever writes projects, deletes included.
select is(h16_live('portfolio_media', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'portfolio_media: update, the live personas');
select is(h16_stale('portfolio_media', 'update'), '', 'portfolio_media: update, no stale token writes a row');
select is(h16_live('portfolio_media', 'delete'), 'A1 C1 S0 D0 L0 O0 Nx', 'portfolio_media: delete, the live personas');
select is(h16_stale('portfolio_media', 'delete'), '', 'portfolio_media: delete, no stale token writes a row');
select is(h16_live('portfolio_media', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'portfolio_media: insert, the live personas');
select is(h16_stale('portfolio_media', 'insert'), '', 'portfolio_media: insert, no stale token writes a row');
-- portfolio_services: a project's service links: whoever writes projects, deletes included.
select is(h16_live('portfolio_services', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'portfolio_services: update, the live personas');
select is(h16_stale('portfolio_services', 'update'), '', 'portfolio_services: update, no stale token writes a row');
select is(h16_live('portfolio_services', 'delete'), 'A1 C1 S0 D0 L0 O0 Nx', 'portfolio_services: delete, the live personas');
select is(h16_stale('portfolio_services', 'delete'), '', 'portfolio_services: delete, no stale token writes a row');
select is(h16_live('portfolio_services', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'portfolio_services: insert, the live personas');
select is(h16_stale('portfolio_services', 'insert'), '', 'portfolio_services: insert, no stale token writes a row');
-- redirects: redirects: Admin and SEO.
select is(h16_live('redirects', 'update'), 'A1 C0 S1 D0 L0 O0 Nx', 'redirects: update, the live personas');
select is(h16_stale('redirects', 'update'), '', 'redirects: update, no stale token writes a row');
select is(h16_live('redirects', 'delete'), 'A1 C0 S1 D0 L0 O0 Nx', 'redirects: delete, the live personas');
select is(h16_stale('redirects', 'delete'), '', 'redirects: delete, no stale token writes a row');
select is(h16_live('redirects', 'insert'), 'A1 Cx S1 Dx L0 O0 Nx', 'redirects: insert, the live personas');
select is(h16_stale('redirects', 'insert'), '', 'redirects: insert, no stale token writes a row');
select is(h16_live('sectors', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'sectors: update, the live personas');
select is(h16_stale('sectors', 'update'), '', 'sectors: update, no stale token writes a row');
select is(h16_live('sectors', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'sectors: delete, the live personas');
select is(h16_stale('sectors', 'delete'), '', 'sectors: delete, no stale token writes a row');
select is(h16_live('sectors', 'insert'), 'A1 C1 Sx Dx Lx O0 Nx', 'sectors: insert, the live personas');
select is(h16_stale('sectors', 'insert'), '', 'sectors: insert, no stale token writes a row');
-- seo_defaults: global SEO defaults: Admin and SEO; one row per tenant; no staff delete.
select is(h16_live('seo_defaults', 'update'), 'A1 C0 S1 D0 L0 O0 Nx', 'seo_defaults: update, the live personas');
select is(h16_stale('seo_defaults', 'update'), '', 'seo_defaults: update, no stale token writes a row');
select is(h16_live('seo_defaults', 'delete'), 'Ax Cx Sx Dx Lx Ox Nx', 'seo_defaults: delete, the live personas');
select is(h16_stale('seo_defaults', 'delete'), '', 'seo_defaults: delete, no stale token writes a row');
select is(h16_live('seo_defaults', 'insert'), 'Au Cx Su Dx Lx O0 Nx', 'seo_defaults: insert, the live personas');
select is(h16_stale('seo_defaults', 'insert'), '', 'seo_defaults: insert, no stale token writes a row');
select is(h16_live('service_cases', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'service_cases: update, the live personas');
select is(h16_stale('service_cases', 'update'), '', 'service_cases: update, no stale token writes a row');
select is(h16_live('service_cases', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'service_cases: delete, the live personas');
select is(h16_stale('service_cases', 'delete'), '', 'service_cases: delete, no stale token writes a row');
select is(h16_live('service_cases', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'service_cases: insert, the live personas');
select is(h16_stale('service_cases', 'insert'), '', 'service_cases: insert, no stale token writes a row');
select is(h16_live('services', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'services: update, the live personas');
select is(h16_stale('services', 'update'), '', 'services: update, no stale token writes a row');
select is(h16_live('services', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'services: delete, the live personas');
select is(h16_stale('services', 'delete'), '', 'services: delete, no stale token writes a row');
select is(h16_live('services', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'services: insert, the live personas');
select is(h16_stale('services', 'insert'), '', 'services: insert, no stale token writes a row');
select is(h16_live('statistics', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'statistics: update, the live personas');
select is(h16_stale('statistics', 'update'), '', 'statistics: update, no stale token writes a row');
select is(h16_live('statistics', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'statistics: delete, the live personas');
select is(h16_stale('statistics', 'delete'), '', 'statistics: delete, no stale token writes a row');
select is(h16_live('statistics', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'statistics: insert, the live personas');
select is(h16_stale('statistics', 'insert'), '', 'statistics: insert, no stale token writes a row');
-- system_logs: staff insert log lines, Admin clears them; no policy updates one.
select is(h16_live('system_logs', 'update'), 'A0 C0 S0 D0 L0 O0 Nx', 'system_logs: update, the live personas');
select is(h16_stale('system_logs', 'update'), '', 'system_logs: update, no stale token writes a row');
select is(h16_live('system_logs', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'system_logs: delete, the live personas');
select is(h16_stale('system_logs', 'delete'), '', 'system_logs: delete, no stale token writes a row');
select is(h16_live('system_logs', 'insert'), 'A1 C1 S1 D1 Lx Ox Nx', 'system_logs: insert, the live personas');
select is(h16_stale('system_logs', 'insert'), '', 'system_logs: insert, no stale token writes a row');
select is(h16_live('team_members', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'team_members: update, the live personas');
select is(h16_stale('team_members', 'update'), '', 'team_members: update, no stale token writes a row');
select is(h16_live('team_members', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'team_members: delete, the live personas');
select is(h16_stale('team_members', 'delete'), '', 'team_members: delete, no stale token writes a row');
select is(h16_live('team_members', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'team_members: insert, the live personas');
select is(h16_stale('team_members', 'insert'), '', 'team_members: insert, no stale token writes a row');
select is(h16_live('testimonials', 'update'), 'A1 C1 S0 D0 L0 O0 Nx', 'testimonials: update, the live personas');
select is(h16_stale('testimonials', 'update'), '', 'testimonials: update, no stale token writes a row');
select is(h16_live('testimonials', 'delete'), 'A1 C0 S0 D0 L0 O0 Nx', 'testimonials: delete, the live personas');
select is(h16_stale('testimonials', 'delete'), '', 'testimonials: delete, no stale token writes a row');
select is(h16_live('testimonials', 'insert'), 'A1 C1 Sx Dx L0 O0 Nx', 'testimonials: insert, the live personas');
select is(h16_stale('testimonials', 'insert'), '', 'testimonials: insert, no stale token writes a row');

-- ── 3. the policies, and the rule ─────────────────────────────────────────────────────────
select is(
  (select count(*)::int
     from pg_policy p
     join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (select t from h16_target)
      and p.polname = c.relname || case p.polcmd when 'a' then '_live_insert'
                                                 when 'w' then '_live_update'
                                                 when 'd' then '_live_delete' end
      and not p.polpermissive
      and p.polroles = array['authenticated'::regrole::oid]
      and coalesce(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))
          ~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND \(\( SELECT (app\.)?live_role\(\) AS live_role\) IS NOT NULL\)\)$'
      and (p.polcmd <> 'w' or pg_get_expr(p.polqual, p.polrelid) = pg_get_expr(p.polwithcheck, p.polrelid))
      and (p.polcmd <> 'a' or p.polqual is null)
      and (p.polcmd <> 'd' or p.polwithcheck is null)),
  84,
  'each of the 28 tables carries the three RESTRICTIVE live policies, TO authenticated alone, the tenant predicate first');

-- Every public table where authenticated holds a write privilege, and the commands it can run
-- with no RESTRICTIVE policy that reads the live profile.
create function h16_unguarded() returns text language sql stable as $$
  with t as (
    select c.oid, c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
  ), need as (
    select t.oid, t.relname, cmd.c
      from t
      cross join lateral (values
        ('a', has_table_privilege('authenticated', t.oid, 'INSERT')
              or has_any_column_privilege('authenticated', t.oid, 'INSERT')),
        ('w', has_table_privilege('authenticated', t.oid, 'UPDATE')
              or has_any_column_privilege('authenticated', t.oid, 'UPDATE')),
        ('d', has_table_privilege('authenticated', t.oid, 'DELETE'))) as cmd(c, held)
     where cmd.held
  )
  select coalesce(string_agg(need.relname || ':' || need.c, ', ' order by need.relname, need.c), '')
    from need
   where not exists (
     select 1 from pg_policy p
      where p.polrelid = need.oid
        and not p.polpermissive
        and p.polcmd in (need.c::"char", '*')
        and (p.polroles = array[0::oid] or 'authenticated'::regrole::oid = any (p.polroles))
        and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
              || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
            ~ '(live_role|is_live_admin)\(\)')
$$;
select is(h16_unguarded(), '',
  'every staff-writable table has a RESTRICTIVE live policy for each write command staff can run');
create table public.h16_probe (tenant_id uuid);
revoke all on public.h16_probe from public, anon, authenticated, service_role;
grant insert, delete on public.h16_probe to authenticated;
select is(h16_unguarded(), 'h16_probe:a, h16_probe:d',
  'and the rule names a table that has none, command by command');
drop table public.h16_probe;

-- The live role is read once per statement, in an InitPlan, never once per row.
create function h16_plan(p_sql text) returns text language plpgsql as $f$
declare
  r record;
  v text := '';
begin
  for r in execute 'explain (verbose, costs off) ' || p_sql loop
    v := v || r."QUERY PLAN" || chr(10);
  end loop;
  return v;
end $f$;
grant execute on function h16_plan(text) to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-8000-0000000000a1","role":"authenticated","app_metadata":{"role":"admin","tenant_id":"b1600000-0000-4000-8000-000000000001"}}', true);
select ok(
  (select p ~ 'InitPlan'
          and not exists (
            select 1 from regexp_split_to_table(p, chr(10)) as line
             where line ~ 'live_role\(\)' and line !~ '^\s*Output: (app\.)?live_role\(\)$')
     from h16_plan($$update public.page_sections set tenant_id = tenant_id
                     where tenant_id = 'b1600000-0000-4000-8000-000000000001'$$) as p),
  'an UPDATE over many rows calls app.live_role() only as an InitPlan (once per statement)');
select set_config('request.jwt.claims', '', true);
reset role;

-- ── 4. update_media_meta ─────────────────────────────────────────────────────────────────
select ok(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'public.update_media_meta(uuid, int, jsonb)'::regprocedure),
  'update_media_meta is a definer with an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.update_media_meta(uuid, int, jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.update_media_meta(uuid, int, jsonb)', 'execute')
    and not has_function_privilege('service_role', 'public.update_media_meta(uuid, int, jsonb)', 'execute'),
  'and authenticated alone may call it');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-8000-0000000000e1","app_metadata":{"role":"seo","tenant_id":"b1600000-0000-4000-8000-000000000001"}}', true);
select is(
  (select count(*)::int from public.update_media_meta('b1600000-0000-4000-8000-00000000b601',
     (select version from public.media_assets where id = 'b1600000-0000-4000-8000-00000000b601'),
     '{"alt":{"en":"Alt","ar":"بديل"}}')),
  1, 'a live SEO token still writes media metadata');
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-8000-0000000000e2","app_metadata":{"role":"seo","tenant_id":"b1600000-0000-4000-8000-000000000001"}}', true);
select throws_ok(
  $$ select * from public.update_media_meta('b1600000-0000-4000-8000-00000000b601', 1, '{"tags":["x"]}') $$,
  '42501', null, 'a demoted SEO token is refused');
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-8000-0000000000e3","app_metadata":{"role":"seo","tenant_id":"b1600000-0000-4000-8000-000000000001"}}', true);
select throws_ok(
  $$ select * from public.update_media_meta('b1600000-0000-4000-8000-00000000b601', 1, '{"tags":["x"]}') $$,
  '42501', null, 'so is a switched-off one');
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-8000-0000000000e4","app_metadata":{"role":"seo","tenant_id":"b1600000-0000-4000-8000-000000000001"}}', true);
select throws_ok(
  $$ select * from public.update_media_meta('b1600000-0000-4000-8000-00000000b601', 1, '{"tags":["x"]}') $$,
  '42501', null, 'and a locked one');
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-8000-000000000051","app_metadata":{"role":"sales","tenant_id":"b1600000-0000-4000-8000-000000000001"}}', true);
select throws_ok(
  $$ select * from public.update_media_meta('b1600000-0000-4000-8000-00000000b601', 1, '{"tags":["x"]}') $$,
  '42501', null, 'Sales was never staff here, and still is not');
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-8000-0000000000f1","app_metadata":{"role":"admin","tenant_id":"b1600000-0000-4000-8000-0000000000ff"}}', true);
select is(
  (select count(*)::int from public.update_media_meta('b1600000-0000-4000-8000-00000000b601', 2, '{"tags":["x"]}')),
  0, 'another tenant''s Admin changes none of T1''s media');
select set_config('request.jwt.claims', '', true);
reset role;
set local role anon;
select throws_ok(
  $$ select * from public.update_media_meta('b1600000-0000-4000-8000-00000000b601', 2, '{"tags":["x"]}') $$,
  '42501', null, 'anon cannot call it');
reset role;
select is(
  (select (alt ->> 'en') || '/' || coalesce(array_to_string(tags, ','), '')
     from public.media_assets where id = 'b1600000-0000-4000-8000-00000000b601'),
  'Alt/', 'only the live SEO''s change stuck');

select * from finish();
rollback;
