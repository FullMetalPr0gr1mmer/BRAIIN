-- pgTAP: lead attribution (Admin v2 C13, crm.md §7.3; HELD for O-11). Run with
-- `supabase test db`.
--
-- Covers: the seven nullable columns and their CHECKs (a path with a query, a fragment, an
-- `@` or a run of seven digits refused; a host name, never a URL; bounded lower-case tags; three
-- device classes; a two-letter country); arrival through crm_ingest_lead with and without the
-- attribution (without it, a lead is what it was before C13: every column null, channel
-- unknown), a refused value refusing the insert (the Worker then sends the lead without it), an
-- unknown key still refused; the grants (lead workers read the columns, nobody writes them,
-- anon nothing; the service role inserts and reads them) and the rows (Admin, Developer and
-- Sales read their tenant's lead; Content Creator, SEO, a demoted, a deactivated and a locked
-- token and another tenant's Admin read none). CLAUDE.md §3, §7 Consent, §8, §9.
-- (C13 review) The shape CHECKs also refuse a percent-escape in a path, a phone number split by
-- separators in a path or a tag, and an IP address as a referrer host.

begin;
select plan(48);

insert into public.tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'T1'),
  ('00000000-0000-0000-0000-0000000000ff', 'T2');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'creator@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'developer@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'demoted-developer@example.test'),
  ('00000000-0000-0000-0000-0000000000d3', 'deactivated-developer@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'locked-developer@example.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'sales@example.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'seo@example.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'other-admin@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'developer', true, null),
  -- demoted: the token still says developer
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-000000000001', 'developer', false, null),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-000000000001', 'developer', true, now() + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'sales', true, null),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000ff', 'admin', true, null);

create function _as(p_sub text, p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_strip_nulls(jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid)))::text end,
    true
  )
$$;

-- A lead with one attribution column set, as the table owner (the CHECKs, nothing else).
create function _attr(p_column text, p_value text) returns void language plpgsql as $f$
begin
  execute format(
    'insert into public.leads (tenant_id, name, email_enc, message, %I) values (%L, %L, %L, %L, %L)',
    p_column, '00000000-0000-0000-0000-000000000001', 'Shape', 'x', 'hi', p_value);
end $f$;

-- ---- 1. The columns and their shapes -----------------------------------------------------------
select is(
  (select array_agg(a.attname::text order by a.attname::text)
     from pg_attribute a
    where a.attrelid = 'public.leads'::regclass and a.attnum > 0 and not a.attisdropped
      and not a.attnotnull
      and a.attname::text in ('landing_path', 'referrer_host', 'utm_source', 'utm_medium',
                              'utm_campaign', 'device_class', 'country')),
  array['country', 'device_class', 'landing_path', 'referrer_host', 'utm_campaign', 'utm_medium',
        'utm_source'],
  'leads carries the seven attribution columns, every one nullable');

select lives_ok($$ select _attr('landing_path', '/') $$, 'a path: the home page');
select lives_ok($$ select _attr('landing_path', '/ar/services/logo') $$, 'a path: an Arabic service page');
select throws_ok($$ select _attr('landing_path', '/contact?email=someone') $$, '23514', null,
  'a path never carries a query');
select throws_ok($$ select _attr('landing_path', '/contact#inquiry') $$, '23514', null,
  'a path never carries a fragment');
select throws_ok($$ select _attr('landing_path', 'https://example.test/contact') $$, '23514', null,
  'a path is never a URL');
select throws_ok($$ select _attr('landing_path', '/x/someone@example.test') $$, '23514', null,
  'a path with an @ is refused (an address must never be stored here)');
select throws_ok($$ select _attr('landing_path', '/x/0501234567') $$, '23514', null,
  'a path with a run of seven digits is refused (a phone number must never be stored here)');
select throws_ok($$ select _attr('landing_path', '/' || repeat('a', 200)) $$, '23514', null,
  'a path is at most 200 characters');
select throws_ok($$ select _attr('landing_path', '/contact/someone%40example.test') $$, '23514', null,
  'a path with a percent-escape is refused (%40 is an @)');
select throws_ok($$ select _attr('landing_path', '/contact/050-123-4567') $$, '23514', null,
  'a path with a phone number split by separators is refused');

select lives_ok($$ select _attr('referrer_host', 'www.google.com') $$, 'a host name');
select lives_ok($$ select _attr('referrer_host', 'xn--mgbh0fb.example') $$, 'an IDN host in its ASCII form');
select throws_ok($$ select _attr('referrer_host', 'https://www.google.com/search') $$, '23514', null,
  'a referrer is a host name, never a URL');
select throws_ok($$ select _attr('referrer_host', 'Google.com') $$, '23514', null,
  'a host name is lower case');
select throws_ok($$ select _attr('referrer_host', 'localhost') $$, '23514', null,
  'a host name has a dot');
select throws_ok($$ select _attr('referrer_host', '192.168.1.5') $$, '23514', null,
  'a referrer host is never an IP address');

select lives_ok($$ select _attr('utm_campaign', 'spring_launch-2026.v2') $$, 'a campaign tag');
select throws_ok($$ select _attr('utm_source', 'someone@example.test') $$, '23514', null,
  'a tag with an @ is refused');
select throws_ok($$ select _attr('utm_medium', 'CPC') $$, '23514', null, 'a tag is lower case');
select throws_ok($$ select _attr('utm_campaign', 'call-0501234567') $$, '23514', null,
  'a tag with a run of seven digits is refused');
select throws_ok($$ select _attr('utm_campaign', 'call-050-123-4567') $$, '23514', null,
  'a tag with a phone number split by separators is refused');
select throws_ok($$ select _attr('utm_campaign', repeat('a', 65)) $$, '23514', null,
  'a tag is at most 64 characters');

select lives_ok($$ select _attr('device_class', 'tablet') $$, 'a device class');
select throws_ok($$ select _attr('device_class', 'iphone') $$, '23514', null,
  'a device class is mobile, tablet or desktop, never a model');
select lives_ok($$ select _attr('country', 'SA') $$, 'a country');
select throws_ok($$ select _attr('country', 'Riyadh') $$, '23514', null,
  'a country is a two-letter code, never a city');

-- ---- 2. Arrival ------------------------------------------------------------------------------
set local role service_role;
select is(
  public.crm_ingest_lead('00000000-0000-0000-0000-000000000001', jsonb_build_object(
    'id', '00000000-0000-0000-0000-00000000c131', 'name', 'Attributed', 'email_enc', 'x',
    'message', 'hi', 'source', 'web_form', 'channel', 'paid', 'score_signals', '["service_page"]'::jsonb,
    'landing_path', '/services/logo', 'referrer_host', 'www.google.com', 'utm_source', 'google',
    'utm_medium', 'cpc', 'utm_campaign', 'spring', 'device_class', 'mobile', 'country', 'SA')),
  '00000000-0000-0000-0000-00000000c131'::uuid, 'a lead with its attribution arrives');
select is(
  public.crm_ingest_lead('00000000-0000-0000-0000-000000000001', jsonb_build_object(
    'id', '00000000-0000-0000-0000-00000000c132', 'name', 'Plain', 'email_enc', 'x',
    'message', 'hi', 'source', 'web_form')),
  '00000000-0000-0000-0000-00000000c132'::uuid, 'a lead without consent arrives as before C13');
select throws_ok(
  $$ select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001', jsonb_build_object(
       'id', '00000000-0000-0000-0000-00000000c133', 'name', 'Bad', 'email_enc', 'x',
       'message', 'hi', 'landing_path', '/contact?q=1')) $$,
  '23514', null, 'a value out of shape refuses the insert (the Worker sends the lead again without it)');
select throws_ok(
  $$ select public.crm_ingest_lead('00000000-0000-0000-0000-000000000001', jsonb_build_object(
       'id', '00000000-0000-0000-0000-00000000c134', 'name', 'Bad', 'email_enc', 'x',
       'message', 'hi', 'referrer_url', 'https://example.test/?x=1')) $$,
  '22023', null, 'a key off the allow-list is still refused');
reset role;
select is(
  (select array[landing_path, referrer_host, utm_source, utm_medium, utm_campaign, device_class,
                country, channel, score::text]
     from public.leads where id = '00000000-0000-0000-0000-00000000c131'),
  array['/services/logo', 'www.google.com', 'google', 'cpc', 'spring', 'mobile', 'SA', 'paid', '10'],
  'every value is stored as sent, and service_page scores its default points');
select is(
  (select array[landing_path, referrer_host, utm_source, utm_medium, utm_campaign, device_class,
                country, channel]
     from public.leads where id = '00000000-0000-0000-0000-00000000c132'),
  array[null, null, null, null, null, null, null, 'unknown']::text[],
  'without the keys nothing is stored, and the channel is unknown');
select ok(
  not exists (select 1 from public.leads where id = '00000000-0000-0000-0000-00000000c133'),
  'the refused lead was not stored');

-- ---- 3. Grants -------------------------------------------------------------------------------
select ok(
  (select bool_and(has_column_privilege('authenticated', 'public.leads', c, 'select')
                   and not has_column_privilege('authenticated', 'public.leads', c, 'insert, update, references')
                   and not has_column_privilege('anon', 'public.leads', c, 'select, insert, update, references')
                   and not has_column_privilege('public', 'public.leads', c, 'select, insert, update, references'))
     from unnest(array['landing_path', 'referrer_host', 'utm_source', 'utm_medium', 'utm_campaign',
                       'device_class', 'country']) c),
  'lead workers read the attribution and write none of it; anon and PUBLIC hold nothing on it');
select ok(
  (select bool_and(has_column_privilege('service_role', 'public.leads', c, 'select')
                   and has_column_privilege('service_role', 'public.leads', c, 'insert'))
     from unnest(array['landing_path', 'referrer_host', 'utm_source', 'utm_medium', 'utm_campaign',
                       'device_class', 'country']) c),
  'the service role inserts the attribution (crm_ingest_lead is SECURITY INVOKER) and reads it (the backfill)');
select ok(
  has_function_privilege('service_role', 'public.crm_ingest_lead(uuid, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.crm_ingest_lead(uuid, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.crm_ingest_lead(uuid, jsonb)', 'execute')
  and not (select prosecdef from pg_proc where oid = 'public.crm_ingest_lead(uuid, jsonb)'::regprocedure),
  'crm_ingest_lead is still the service role''s alone, SECURITY INVOKER');

-- ---- 4. Who reads which rows ----------------------------------------------------------------------
set local role authenticated;
select _as('00000000-0000-0000-0000-0000000000a1', 'admin', '00000000-0000-0000-0000-000000000001');
select is(
  (select landing_path || ' ' || referrer_host from public.leads
    where id = '00000000-0000-0000-0000-00000000c131'),
  '/services/logo www.google.com', 'admin reads the attribution of its tenant''s lead');
select throws_ok(
  $$ update public.leads set landing_path = '/x' where id = '00000000-0000-0000-0000-00000000c131' $$,
  '42501', null, 'admin cannot rewrite what arrived with the inquiry');
select _as('00000000-0000-0000-0000-0000000000d1', 'developer', '00000000-0000-0000-0000-000000000001');
select is(
  (select country from public.leads where id = '00000000-0000-0000-0000-00000000c131'),
  'SA', 'developer reads it (leads.manage)');
select _as('00000000-0000-0000-0000-0000000000b1', 'sales', '00000000-0000-0000-0000-000000000001');
select is(
  (select utm_campaign from public.leads where id = '00000000-0000-0000-0000-00000000c131'),
  'spring', 'sales reads it (leads.manage since 0097)');
select _as('00000000-0000-0000-0000-0000000000c1', 'content_creator', '00000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.leads where landing_path is not null), 0,
  'content creator reads no lead');
select _as('00000000-0000-0000-0000-0000000000e1', 'seo', '00000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.leads where landing_path is not null), 0, 'seo reads no lead');
select _as('00000000-0000-0000-0000-0000000000d2', 'developer', '00000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.leads where landing_path is not null), 0,
  'a demoted developer''s token reads no lead (the live check)');
select _as('00000000-0000-0000-0000-0000000000d3', 'developer', '00000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.leads where landing_path is not null), 0,
  'a deactivated developer''s token reads no lead (the live check)');
select _as('00000000-0000-0000-0000-0000000000d4', 'developer', '00000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.leads where landing_path is not null), 0,
  'a locked developer''s token reads no lead (the live check)');
select _as('00000000-0000-0000-0000-0000000000f1', 'admin', '00000000-0000-0000-0000-0000000000ff');
select is(
  (select count(*)::int from public.leads where landing_path is not null), 0,
  'another tenant''s admin reads none of this tenant''s leads');
reset role;
set local role anon;
select throws_ok(
  $$ select landing_path from public.leads $$, '42501', null, 'anon cannot read the column at all');
reset role;

select * from finish();
rollback;
