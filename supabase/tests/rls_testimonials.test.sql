-- pgTAP: public.testimonials (migration 0021).
--
-- A quote is a real person's words about a real engagement. Two rules no write path may
-- skip:
--   1. it cannot be PUBLISHED or SCHEDULED without recorded consent — a CHECK, so admin,
--      PostgREST, the seed, the cron and the service role are all held to it (scheduled
--      too, or app.publish_scheduled() would publish an unconsented quote on a timer);
--   2. the consent record is never readable by anon — a COLUMN-level grant.
-- Plus the content-table shape: Admin + Content Creator write, archive/delete Admin-only.
--
-- 0028 (owner decision 2026-09-27: show the design's sample quotes): rule 1 becomes
-- "consent, or a flagged design sample" — and so that the flag cannot become a way round
-- consent, a trigger locks samples against staff (any JWT carrying a staff role):
--   • staff can never create a sample, nor turn a quote into one (flag false → true);
--   • a sample's words and attribution never change while it stays a sample;
--   • clearing the flag is always allowed — and from then on the consent CHECK applies.
-- Seeds, psql and the cron carry no JWT: only they create or edit samples.

begin;
select plan(38);

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
select throws_ok(
  $$ insert into public.testimonials (tenant_id, slug, quote, author_name, status, scheduled_for, consent_obtained_at, portfolio_id)
     values ('63000000-0000-0000-0000-000000000001', 'pg-q-sched-dup', '{"en":"Q","ar":"ق"}', '{"en":"A","ar":"أ"}',
             'scheduled', now() + interval '1 day', now(), '63000000-0000-0000-0000-00000000c001') $$,
  '23505', null,
  'a second quote cannot be SCHEDULED behind a published one (it would abort the cron at flip time)');

-- ── 5. design samples (0028): consent-or-sample, and the sample lock ─────────
-- As the owner (no JWT), exactly as the seed files run.
reset role;
select _claims(null, null);
select lives_ok(
  $$ insert into public.testimonials (tenant_id, slug, quote, author_name, status, is_placeholder)
     values ('63000000-0000-0000-0000-000000000001', 'pg-q-sample', '{"en":"S","ar":"ع"}',
             '{"en":"Client name","ar":"اسم العميل"}', 'published', true),
            ('63000000-0000-0000-0000-000000000001', 'pg-q-sample-d', '{"en":"S2","ar":"ع"}',
             '{"en":"Client name","ar":"اسم العميل"}', 'draft', true) $$,
  'consent-or-sample: a flagged design sample may be published without consent (outside production)');
select lives_ok(
  $$ update public.testimonials set quote = '{"en":"S, reworded","ar":"ع"}' where slug = 'pg-q-sample-d' $$,
  'the seed path (no JWT) may still edit a sample — the lock acts for staff only');

set local role authenticated;
select _claims('admin', _tid());
select throws_ok(
  $$ insert into public.testimonials (tenant_id, slug, quote, author_name, status, is_placeholder)
     values (_tid()::uuid, 'pg-q-fake', '{"en":"Q","ar":"ق"}', '{"en":"A","ar":"أ"}', 'draft', true) $$,
  '42501', null, 'even admin cannot CREATE a sample, not even as a draft');
select _claims('content_creator', _tid());
select throws_ok(
  $$ update public.testimonials set is_placeholder = true where slug = 'pg-q-pub' $$,
  '42501', null, 'nor turn a real quote into a sample (the flag is cleared, never set)');
select throws_ok(
  $$ update public.testimonials set quote = '{"en":"A real person said this","ar":"ق"}' where slug = 'pg-q-sample' $$,
  '42501', null, 'nor edit a LIVE sample''s words while it stays a sample');
select throws_ok(
  $$ update public.testimonials set author_name = '{"en":"A real name","ar":"اسم"}' where slug = 'pg-q-sample-d' $$,
  '42501', null, 'nor a DRAFT sample''s attribution (unpublish, rename, republish is the hole)');
select throws_ok(
  $$ update public.testimonials set portfolio_id = '63000000-0000-0000-0000-00000000c001' where slug = 'pg-q-sample-d' $$,
  '42501', null, 'nor tie a sample to a real project');
select lives_ok(
  $$ update public.testimonials set sort_order = 7, status = 'draft' where slug = 'pg-q-sample' $$,
  'a sample''s order and status stay editable (it can always be taken down)');
select lives_ok(
  $$ update public.testimonials set status = 'published' where slug = 'pg-q-sample' $$,
  'and put back up (0025 decides where that is allowed)');

select _claims('admin', _tid());
select throws_ok(
  $$ update public.testimonials set is_placeholder = false where slug = 'pg-q-sample' $$,
  '23514', null, 'clearing the flag of a LIVE sample without consent is refused (it is real now)');
select lives_ok(
  $$ update public.testimonials
        set quote = '{"en":"Real words","ar":"كلمات حقيقية"}', author_name = '{"en":"Real Person","ar":"شخص حقيقي"}',
            consent_obtained_at = now(), consent_reference = 'signed-form-7', is_placeholder = false
      where slug = 'pg-q-sample' $$,
  'make it real in ONE save: the real words, the consent record and the flag cleared together');
select is(
  (select is_placeholder::text || '/' || status::text || '/' || (quote ->> 'en')
     from public.testimonials where slug = 'pg-q-sample'),
  'false/published/Real words', 'it stays published, now as a real, consented quote');

select _claims('content_creator', _tid());
select lives_ok(
  $$ update public.testimonials set is_placeholder = false where slug = 'pg-q-sample-d' $$,
  'clearing the flag on a DRAFT sample needs no consent yet');
select throws_ok(
  $$ update public.testimonials set status = 'published' where slug = 'pg-q-sample-d' $$,
  '23514', null, 'and publishing it without consent is then refused — the consent CHECK applies');

select _claims('admin', '00000000-0000-0000-0000-0000000000ff');
update public.testimonials set sort_order = 99 where slug = 'pg-q-sample-d';
reset role;
select _claims(null, null);
select is(
  (select sort_order from public.testimonials where slug = 'pg-q-sample-d'),
  0, 'other_tenant: an admin of another tenant changes nothing (0 rows)');

-- ── structural ───────────────────────────────────────────────────────────────
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.testimonials'::regclass),
  'testimonials has RLS enabled AND forced');
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.testimonials'::regclass
             and tgname = 'testimonials_sample_lock' and not tgisinternal),
  'the 0028 sample lock is attached to testimonials');
select ok(
  not has_function_privilege('authenticated', 'app.tg_testimonial_sample_lock()', 'execute')
  and not has_function_privilege('anon', 'app.tg_testimonial_sample_lock()', 'execute'),
  'the sample lock is not callable by an API role (0011 §6c default-deny)');

select * from finish();
rollback;
