-- pgTAP: the production placeholder guard + dashboard_attention v2 (migration 0025), and the
-- owner's per-table exception to it (0027), widened by 0028 to testimonials and service cases.
--
-- UI v2 decision 7: design-delivery placeholders are PUBLISHED in local/CI/staging (so the
-- environments match the mockup) and never live in production. Outside production the
-- guard is inert; once app.deployment says 'production', no write — any role, the owner
-- included — may leave an is_placeholder row published, scheduled or visible, unless the
-- owner's audited per-(tenant, table) override names that table.
--
-- 0028 (owner decision 2026-09-27): the override may name testimonials — the sample quotes
-- go live — and service_cases. A sample quote needs no consent (the consent-or-sample
-- CHECK), so in production it is the guard, not the CHECK, that holds it back.
--
-- app.deployment is changed inside this transaction only (rolled back at the end).

begin;
select plan(49);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values ('66000000-0000-0000-0000-000000000001', 'PhT');
insert into public.portfolio (id, tenant_id, slug, title, status, is_placeholder) values
  ('66000000-0000-0000-0000-0000000000c1', '66000000-0000-0000-0000-000000000001', 'pg-ph-proj',
   '{"en":"P","ar":"م"}', 'draft', true),
  ('66000000-0000-0000-0000-0000000000c7', '66000000-0000-0000-0000-000000000001', 'pg-ph-real',
   '{"en":"R","ar":"ح"}', 'published', false);
insert into public.clients (id, tenant_id, slug, name, visible, is_placeholder) values
  ('66000000-0000-0000-0000-0000000000c2', '66000000-0000-0000-0000-000000000001', 'pg-ph-client',
   '{"en":"C","ar":"ع"}', false, true);
insert into public.testimonials (id, tenant_id, slug, quote, author_name, status, consent_obtained_at, is_placeholder) values
  ('66000000-0000-0000-0000-0000000000c3', '66000000-0000-0000-0000-000000000001', 'pg-ph-quote',
   '{"en":"Q","ar":"ق"}', '{"en":"A","ar":"أ"}', 'draft', now(), true);
insert into public.team_members (id, tenant_id, slug, name, status, is_placeholder) values
  ('66000000-0000-0000-0000-0000000000c4', '66000000-0000-0000-0000-000000000001', 'pg-ph-leader',
   '{"en":"L","ar":"ق"}', 'draft', true);
insert into public.statistics (id, tenant_id, slug, label, value, status, is_placeholder) values
  ('66000000-0000-0000-0000-0000000000c5', '66000000-0000-0000-0000-000000000001', 'pg-ph-stat',
   '{"en":"S","ar":"إ"}', '12', 'draft', true);
insert into public.pages (id, tenant_id, slug, title, status) values
  ('66000000-0000-0000-0000-0000000000d1', '66000000-0000-0000-0000-000000000001', 'pg-ph-page',
   '{"en":"Pg","ar":"ص"}', 'published');
-- 0027 fixtures: a second placeholder project, and another tenant's (the exception is per tenant).
insert into public.tenants (id, name) values ('66000000-0000-0000-0000-000000000002', 'PhT2');
insert into public.portfolio (id, tenant_id, slug, title, status, is_placeholder) values
  ('66000000-0000-0000-0000-0000000000c8', '66000000-0000-0000-0000-000000000001', 'pg-ph-proj2',
   '{"en":"P2","ar":"م٢"}', 'draft', true),
  ('66000000-0000-0000-0000-0000000000c9', '66000000-0000-0000-0000-000000000002', 'pg-ph-other',
   '{"en":"O","ar":"ع"}', 'draft', true);
insert into public.page_sections (id, tenant_id, page_id, type, visible, is_placeholder) values
  ('66000000-0000-0000-0000-0000000000c6', '66000000-0000-0000-0000-000000000001',
   '66000000-0000-0000-0000-0000000000d1', 'cta', false, true);
-- 0028 fixtures: a sample quote with NO consent (as the design delivery's are), and a
-- placeholder service case on a published service.
insert into public.testimonials (id, tenant_id, slug, quote, author_name, status, is_placeholder) values
  ('66000000-0000-0000-0000-0000000000ca', '66000000-0000-0000-0000-000000000001', 'pg-ph-sample',
   '{"en":"S","ar":"ع"}', '{"en":"Client name","ar":"اسم العميل"}', 'draft', true);
insert into public.services (id, tenant_id, slug, title, status) values
  ('66000000-0000-0000-0000-0000000000e1', '66000000-0000-0000-0000-000000000001', 'pg-ph-svc',
   '{"en":"Svc","ar":"خ"}', 'published');
insert into public.service_cases (id, tenant_id, service_id, title, status, is_placeholder) values
  ('66000000-0000-0000-0000-0000000000cb', '66000000-0000-0000-0000-000000000001',
   '66000000-0000-0000-0000-0000000000e1', '{"en":"Case","ar":"حالة"}', 'draft', true);

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
create function _tid() returns text language sql as $$ select '66000000-0000-0000-0000-000000000001' $$;

-- ── 1. staging: the guard is inert, and the dashboard says so ───────────────
insert into app.deployment (env) values ('staging')
  on conflict (singleton) do update set env = excluded.env;
set local role authenticated;
select _claims('admin', _tid());
select lives_ok(
  $$ update public.portfolio set status = 'published' where slug = 'pg-ph-proj' $$,
  'staging: a placeholder may be published (so the environment matches the mockup)');
select is(
  (select kind from public.dashboard_attention where id = '66000000-0000-0000-0000-0000000000c1'),
  'placeholder_live', 'the dashboard lists a LIVE placeholder');
select is(
  (select kind from public.dashboard_attention where id = '66000000-0000-0000-0000-0000000000c2'),
  'placeholder_pending', 'and a hidden one as awaiting real content');
select lives_ok(
  $$ update public.portfolio set status = 'draft' where slug = 'pg-ph-proj' $$,
  'back to draft');

-- ── 2. production: no path may make a placeholder live ──────────────────────
reset role;
update app.deployment set env = 'production';
set local role authenticated;
select _claims('admin', _tid());
select throws_ok(
  $$ update public.portfolio set status = 'published' where slug = 'pg-ph-proj' $$,
  '42501', null, 'production: even admin cannot PUBLISH a placeholder project');
select throws_ok(
  $$ update public.portfolio set status = 'scheduled', scheduled_for = now() + interval '1 day'
      where slug = 'pg-ph-proj' $$,
  '42501', null, 'nor SCHEDULE it (the cron would publish it without asking)');
select throws_ok(
  $$ update public.clients set visible = true where slug = 'pg-ph-client' $$,
  '42501', null, 'nor make a placeholder client visible');
select throws_ok(
  $$ update public.testimonials set status = 'published' where slug = 'pg-ph-quote' $$,
  '42501', null, 'nor publish a placeholder quote (consent does not make it real)');
select throws_ok(
  $$ update public.testimonials set status = 'published' where slug = 'pg-ph-sample' $$,
  '42501', null,
  'nor an unconsented SAMPLE quote: the consent CHECK lets a sample through (0028), the guard does not');
select throws_ok(
  $$ update public.service_cases set status = 'published' where id = '66000000-0000-0000-0000-0000000000cb' $$,
  '42501', null, 'nor publish a placeholder service case (0028)');
select throws_ok(
  $$ update public.team_members set status = 'published' where slug = 'pg-ph-leader' $$,
  '42501', null, 'nor publish a placeholder leader');
select throws_ok(
  $$ update public.statistics set status = 'published' where slug = 'pg-ph-stat' $$,
  '42501', null, 'nor publish a placeholder statistic');
select throws_ok(
  $$ update public.page_sections set visible = true where id = '66000000-0000-0000-0000-0000000000c6' $$,
  '42501', null, 'nor make a placeholder section visible');
select throws_ok(
  $$ insert into public.portfolio (tenant_id, slug, title, status, is_placeholder)
     values (_tid()::uuid, 'pg-ph-new', '{"en":"N","ar":"ن"}', 'published', true) $$,
  '42501', null, 'nor INSERT one already published');
select throws_ok(
  $$ update public.portfolio set is_placeholder = true where slug = 'pg-ph-real' $$,
  '42501', null, 'nor mark a LIVE row as placeholder');

select _claims('content_creator', _tid());
select lives_ok(
  $$ update public.portfolio set title = '{"en":"Edited","ar":"معدل"}' where slug = 'pg-ph-proj' $$,
  'a placeholder draft can still be edited');
select lives_ok(
  $$ update public.portfolio set is_placeholder = false, status = 'published' where slug = 'pg-ph-proj' $$,
  'replacing the content and clearing is_placeholder IS the way to publish it');

-- The owner / service-role path is not exempt: this is a statement about the data.
-- psql and the seed files carry no JWT — clear the claims, or the 0028 sample lock (which
-- acts for staff only) would treat this session as the content_creator above.
reset role;
select _claims(null, null);
select throws_ok(
  $$ update public.clients set visible = true where slug = 'pg-ph-client' $$,
  '42501', null, 'production: the owner (service role / psql) is held to it too');
select lives_ok(
  $$ insert into public.testimonials (tenant_id, slug, quote, author_name, status, is_placeholder)
     values ('66000000-0000-0000-0000-000000000001', 'pg-ph-draft', '{"en":"Q","ar":"ق"}',
             '{"en":"A","ar":"أ"}', 'draft', true) $$,
  'production: a placeholder may still be seeded as a draft (production.sql does this)');

-- ── 3. the owner's per-table exception (0027) ───────────────────────────────
-- Still production, still as the owner (the runbook's role).
select throws_ok(
  $$ insert into app.placeholder_live_override (tenant_id, table_name, reason)
     values (_tid()::uuid, 'leads', 'Owner decision: show the design as is') $$,
  '23514', null, 'the override can name only the seven placeholder tables (table CHECK, 0028)');
select throws_ok(
  $$ insert into app.placeholder_live_override (tenant_id, table_name, reason)
     values (_tid()::uuid, 'portfolio', 'ok') $$,
  '23514', null, 'an exception needs a stated reason');
select lives_ok(
  $$ insert into app.placeholder_live_override (tenant_id, table_name, reason)
     values (_tid()::uuid, 'portfolio', 'Owner decision 2026-09-26: show the design as is') $$,
  'the owner allows placeholder PROJECTS to go live for this tenant');
select is(
  (select count(*)::int from public.audit_log
    where tenant_id = _tid()::uuid and entity_type = 'placeholder_override'
      and entity_id = 'portfolio' and action = 'placeholder_override.grant'),
  1, 'the grant is on the audit chain, with its reason');

set local role authenticated;
select _claims('admin', _tid());
select lives_ok(
  $$ update public.portfolio set status = 'published' where slug = 'pg-ph-proj2' $$,
  'with the exception, a placeholder project can be published — flag still set');
select is(
  (select kind from public.dashboard_attention where id = '66000000-0000-0000-0000-0000000000c8'),
  'placeholder_live', 'and the dashboard keeps flagging it as live placeholder content');
select throws_ok(
  $$ update public.clients set visible = true where slug = 'pg-ph-client' $$,
  '42501', null, 'the exception is per TABLE: clients are still guarded');
select throws_ok(
  $$ update public.testimonials set status = 'published' where slug = 'pg-ph-quote' $$,
  '42501', null, 'and quotes are still guarded');
select throws_ok(
  $$ select * from app.placeholder_live_override $$,
  '42501', null, 'authenticated cannot read the exceptions');
set local role anon;
select _claims(null, null);
select throws_ok(
  $$ select * from app.placeholder_live_override $$,
  '42501', null, 'nor can anon');

reset role;
select throws_ok(
  $$ update public.portfolio set status = 'published' where slug = 'pg-ph-other' $$,
  '42501', null, 'the exception is per TENANT: another tenant''s placeholder is still guarded');
select lives_ok(
  $$ delete from app.placeholder_live_override where tenant_id = _tid()::uuid and table_name = 'portfolio' $$,
  'the owner revokes the exception');
select is(
  (select count(*)::int from public.audit_log
    where tenant_id = _tid()::uuid and entity_type = 'placeholder_override'
      and entity_id = 'portfolio' and action = 'placeholder_override.revoke'),
  1, 'the revoke is on the audit chain too');
select lives_ok(
  $$ update public.portfolio set status = 'draft' where slug = 'pg-ph-proj2' $$,
  'taking it down is always allowed');
select throws_ok(
  $$ update public.portfolio set status = 'published' where slug = 'pg-ph-proj2' $$,
  '42501', null, 'once revoked, the guard holds again');

-- ── 4. the sample quotes and service cases (0028, owner decision 2026-09-27) ──
-- Still production. The owner (no JWT) grants the testimonials exception.
reset role;
select _claims(null, null);
select lives_ok(
  $$ insert into app.placeholder_live_override (tenant_id, table_name, reason)
     values (_tid()::uuid, 'testimonials', 'Owner decision 2026-09-27: show the sample quotes') $$,
  '0028: the owner may now allow the sample QUOTES to go live for this tenant');
select is(
  (select count(*)::int from public.audit_log
    where tenant_id = _tid()::uuid and entity_type = 'placeholder_override'
      and entity_id = 'testimonials' and action = 'placeholder_override.grant'),
  1, 'that grant is on the audit chain, with its reason');

set local role authenticated;
select _claims('admin', _tid());
select lives_ok(
  $$ update public.testimonials set status = 'published' where slug = 'pg-ph-sample' $$,
  'with the exception, an unconsented sample quote publishes in production — flag still set');
select is(
  (select kind from public.dashboard_attention
    where id = '66000000-0000-0000-0000-0000000000ca' and kind like 'placeholder_%'),
  'placeholder_live', 'and the dashboard keeps flagging it as a live sample');
select throws_ok(
  $$ update public.testimonials set author_name = '{"en":"A real person","ar":"شخص"}'
      where slug = 'pg-ph-sample' $$,
  '42501', null, 'but its words and attribution stay locked while it is a sample (sample lock)');
select throws_ok(
  $$ update public.service_cases set status = 'published' where id = '66000000-0000-0000-0000-0000000000cb' $$,
  '42501', null, 'the testimonials exception does not open service cases (per table)');

reset role;
select _claims(null, null);
select lives_ok(
  $$ insert into app.placeholder_live_override (tenant_id, table_name, reason)
     values (_tid()::uuid, 'service_cases', 'Owner decision 2026-09-27: sample case blocks go live') $$,
  '0028: the owner may allow the sample service cases too');
set local role authenticated;
select _claims('admin', _tid());
select lives_ok(
  $$ update public.service_cases set status = 'published' where id = '66000000-0000-0000-0000-0000000000cb' $$,
  'with its own exception, a placeholder service case goes live');
select is(
  (select kind from public.dashboard_attention where id = '66000000-0000-0000-0000-0000000000cb'),
  'placeholder_live', 'dashboard_attention lists the live placeholder case (0028)');

reset role;
select _claims(null, null);
select lives_ok(
  $$ delete from app.placeholder_live_override
      where tenant_id = _tid()::uuid and table_name in ('testimonials', 'service_cases') $$,
  'the owner revokes both exceptions');
select is(
  (select count(*)::int from public.audit_log
    where tenant_id = _tid()::uuid and entity_type = 'placeholder_override'
      and entity_id in ('testimonials', 'service_cases') and action = 'placeholder_override.revoke'),
  2, 'both revokes are on the audit chain');
set local role authenticated;
select _claims('admin', _tid());
select lives_ok(
  $$ update public.testimonials set status = 'draft' where slug = 'pg-ph-sample' $$,
  'taking the sample quote down is always allowed');
select throws_ok(
  $$ update public.testimonials set status = 'published' where slug = 'pg-ph-sample' $$,
  '42501', null, 'and without the exception it cannot go back up');

-- ── structural ───────────────────────────────────────────────────────────────
reset role;
select _claims(null, null);
select is(
  (select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where t.tgname = c.relname || '_placeholder_guard' and not t.tgisinternal
      and c.relname in ('portfolio', 'testimonials', 'team_members', 'statistics', 'clients',
                        'page_sections', 'service_cases')),
  7, 'the guard is on all seven tables (service_cases since 0028)');
select ok(
  (select coalesce((select option_value = 'true' from pg_options_to_table(c.reloptions)
                     where option_name = 'security_invoker'), false)
     from pg_class c where c.oid = 'public.dashboard_attention'::regclass),
  'dashboard_attention stays security_invoker (each role sees only what its RLS allows)');

select * from finish();
rollback;
