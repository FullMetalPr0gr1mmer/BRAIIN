-- pgTAP: public.testimonials (migration 0021).
--
-- A quote is a real person's words about a real engagement. Two rules no write path may
-- skip:
--   1. it cannot be PUBLISHED or SCHEDULED without recorded consent — a CHECK, so admin,
--      PostgREST, the seed, the cron and the service role are all held to it (scheduled
--      too, or app.publish_scheduled() would publish an unconsented quote on a timer);
--   2. the consent record is never readable by anon — a COLUMN-level grant.
-- Plus the content-table shape: Admin + Content Creator write, archive/delete Admin-only.

begin;
select plan(20);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values ('63000000-0000-0000-0000-000000000001', 'QuoteT');
insert into public.portfolio (id, tenant_id, slug, title, status) values
  ('63000000-0000-0000-0000-00000000c001', '63000000-0000-0000-0000-000000000001',
   'pg-quote-proj', '{"en":"P","ar":"م"}', 'published');
insert into public.testimonials
  (id, tenant_id, slug, quote, author_name, status, consent_obtained_at, portfolio_id) values
  ('63000000-0000-0000-0000-00000000d001', '63000000-0000-0000-0000-000000000001', 'pg-q-pub',
   '{"en":"Q","ar":"ق"}', '{"en":"A","ar":"أ"}', 'published', now(),
   '63000000-0000-0000-0000-00000000c001'),
  ('63000000-0000-0000-0000-00000000d002', '63000000-0000-0000-0000-000000000001', 'pg-q-draft',
   '{"en":"Q2","ar":"ق"}', '{"en":"B","ar":"ب"}', 'draft', null, null);
-- The launch tenant's quotes — the ones anon is fenced to.
insert into public.testimonials
  (tenant_id, slug, quote, author_name, status, consent_obtained_at, consent_reference) values
  (app.default_tenant_id(), 'pgtap-q-pub', '{"en":"Q","ar":"ق"}', '{"en":"A","ar":"أ"}',
   'published', now(), 'ticket-123'),
  (app.default_tenant_id(), 'pgtap-q-draft', '{"en":"Q","ar":"ق"}', '{"en":"B","ar":"ب"}',
   'draft', null, null);

create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
create function _tid() returns text language sql as $$ select '63000000-0000-0000-0000-000000000001' $$;
create function _n() returns int language sql as $$
  select count(*)::int from public.testimonials where tenant_id = _tid()::uuid $$;
create function _status(p_slug text) returns text language sql as $$
  select status::text from public.testimonials where tenant_id = _tid()::uuid and slug = p_slug $$;

-- ── 1. the consent gate holds on every path ──────────────────────────────────
set local role authenticated;
select _claims('admin', _tid());
select throws_ok(
  $$ insert into public.testimonials (tenant_id, slug, quote, author_name, status)
     values (_tid()::uuid, 'pg-q-x', '{"en":"Q","ar":"ق"}', '{"en":"A","ar":"أ"}', 'published') $$,
  '23514', null, 'even admin cannot PUBLISH a quote without consent');
select throws_ok(
  $$ insert into public.testimonials (tenant_id, slug, quote, author_name, status, scheduled_for)
     values (_tid()::uuid, 'pg-q-y', '{"en":"Q","ar":"ق"}', '{"en":"A","ar":"أ"}', 'scheduled', now()) $$,
  '23514', null, 'nor SCHEDULE one (the cron would publish it without asking)');
select throws_ok(
  $$ update public.testimonials set consent_obtained_at = null where slug = 'pg-q-pub' $$,
  '23514', null, 'nor strip the consent from a published quote');
reset role;
select throws_ok(
  $$ insert into public.testimonials (tenant_id, slug, quote, author_name, status)
     values ('63000000-0000-0000-0000-000000000001', 'pg-q-z', '{"en":"Q","ar":"ق"}', '{"en":"A","ar":"أ"}', 'published') $$,
  '23514', null, 'the owner / service role path is held to the same CHECK');

-- ── 2. authoring: Admin + Content Creator; archive/delete Admin-only ────────
set local role authenticated;
select _claims('content_creator', _tid());
select lives_ok(
  $$ update public.testimonials set consent_obtained_at = now(), status = 'published' where slug = 'pg-q-draft' $$,
  'content_creator publishes a quote once consent is recorded');
select throws_ok(
  $$ update public.testimonials set status = 'archived' where slug = 'pg-q-draft' $$,
  '42501', null, 'content_creator CANNOT archive a quote (RESTRICTIVE, Admin-only)');
delete from public.testimonials where slug = 'pg-q-draft';
select is(_n(), 2, 'content_creator delete is a no-op (RESTRICTIVE, Admin-only)');

select _claims('seo', _tid());
select throws_ok(
  $$ insert into public.testimonials (tenant_id, slug, quote, author_name)
     values (_tid()::uuid, 'pg-q-seo', '{"en":"Q","ar":"ق"}', '{"en":"A","ar":"أ"}') $$,
  '42501', null, 'seo CANNOT author quotes');
select _claims('developer', _tid());
update public.testimonials set status = 'draft' where slug = 'pg-q-pub';
select _claims('admin', _tid());
select is(_status('pg-q-pub'), 'published', 'developer update affected 0 rows');

-- One published quote per case study (the page shows exactly one).
select throws_ok(
  $$ insert into public.testimonials (tenant_id, slug, quote, author_name, status, consent_obtained_at, portfolio_id)
     values (_tid()::uuid, 'pg-q-2nd', '{"en":"Q","ar":"ق"}', '{"en":"A","ar":"أ"}', 'published', now(),
             '63000000-0000-0000-0000-00000000c001') $$,
  '23505', null, 'a second PUBLISHED quote for the same project is refused');
select lives_ok(
  $$ update public.testimonials set status = 'archived' where slug = 'pg-q-draft' $$,
  'admin can archive a quote');

select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
select is(_n(), 0, 'other_tenant admin sees none of this tenant''s quotes');

-- ── 3. anon: published quotes, never the consent record ─────────────────────
reset role;
set local role anon;
select _claims(null, null);
select is(
  (select count(id)::int from public.testimonials where slug in ('pgtap-q-pub', 'pgtap-q-draft')),
  1, 'anon reads the published quote and not the draft');
select is(
  (select quote ->> 'en' from public.testimonials where slug = 'pgtap-q-pub'),
  'Q', 'anon reads the quote text');
select throws_ok(
  $$ select consent_reference from public.testimonials $$,
  '42501', null, 'anon CANNOT read consent_reference (column not granted)');
select throws_ok(
  $$ select * from public.testimonials $$,
  '42501', null, 'anon CANNOT select * (the consent columns are outside its grant)');
select is(
  (select count(id)::int from public.testimonials where tenant_id = _tid()::uuid),
  0, 'anon is fenced to the launch tenant');

-- ── 4. the cron publishes a scheduled (consented) quote ─────────────────────
reset role;
insert into public.testimonials
  (tenant_id, slug, quote, author_name, status, scheduled_for, consent_obtained_at) values
  ('63000000-0000-0000-0000-000000000001', 'pg-q-sched', '{"en":"Q","ar":"ق"}', '{"en":"A","ar":"أ"}',
   'scheduled', now() - interval '1 minute', now());
select ok(app.publish_scheduled() >= 1, 'app.publish_scheduled() ran');
select is(_status('pg-q-sched'), 'published', 'a due, consented quote is published by the cron');

-- ── structural ───────────────────────────────────────────────────────────────
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.testimonials'::regclass),
  'testimonials has RLS enabled AND forced');

select * from finish();
rollback;
