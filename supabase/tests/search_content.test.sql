-- pgTAP: unified search (KAN-29). The Arabic-tokenisation gate (CLAUDE.md §8/§9):
-- recall@5 = 100% over ≥30 curated AR pairs, zero zero-result curated queries, plus
-- normalization unit assertions, tsquery-injection safety, and the tenant+published
-- fence (anon excludes drafts + other tenants). Run with `supabase test db`.
--
-- Deterministic anon fence: app.effective_tenant_id() for anon = app.default_tenant_id()
-- = earliest tenant by created_at. We back-date our test tenant to 2000 so anon ALWAYS
-- resolves to it, independent of any seed rows. A second tenant proves cross-tenant = 0.

begin;
select * from no_plan();

insert into public.tenants (id, name, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'SearchT', '2000-01-01T00:00:00Z'),
  ('22222222-2222-2222-2222-222222222222', 'OtherT', '2000-01-02T00:00:00Z');

-- Claims helper (same shape as rls_services.test.sql).
create function _claims(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object('app_metadata', json_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- recall@5: does the expected slug appear in the top 5 hits for this query?
create function _recall(p_q text, p_loc text, p_slug text) returns boolean language sql as $$
  select exists (
    select 1 from (select slug from public.search_content(p_q, p_loc) limit 5) t
    where t.slug = p_slug
  )
$$;

-- Fixtures in SearchT (published). Generated search_en/search_ar populate via app.ar_tsvector.
insert into public.services (tenant_id, slug, title, blurb, status) values
  ('11111111-1111-1111-1111-111111111111', 'svc-branding',
    '{"en":"Branding","ar":"الهَوِيَّة البصرية"}', '{"en":"identity systems","ar":"أنظمة الهوية"}', 'published'),
  ('11111111-1111-1111-1111-111111111111', 'svc-advertising',
    '{"en":"Advertising","ar":"الإعلانات"}', '{"en":"campaigns","ar":"حملات إعلانية"}', 'published'),
  ('11111111-1111-1111-1111-111111111111', 'svc-music',
    '{"en":"Music","ar":"الموسيقى"}', '{"en":"scoring","ar":"تلحين أصلي"}', 'published'),
  ('11111111-1111-1111-1111-111111111111', 'svc-photography',
    '{"en":"Photography","ar":"التصوير الفوتوغرافي"}', '{"en":"photos","ar":"صور احترافية"}', 'published'),
  ('11111111-1111-1111-1111-111111111111', 'svc-video',
    '{"en":"Videography","ar":"إنتاج الفيديو"}', '{"en":"film","ar":"تصــوير سينمائي"}', 'published'),
  ('11111111-1111-1111-1111-111111111111', 'svc-montage',
    '{"en":"Montage","ar":"المونتاج"}', '{"en":"editing","ar":"مونتاج للقطات"}', 'published');

insert into public.portfolio (tenant_id, slug, title, summary, status) values
  ('11111111-1111-1111-1111-111111111111', 'pf-riyadh',
    '{"en":"Riyadh Season","ar":"موسم الرياض"}', '{"en":"campaign","ar":"حملة متكاملة"}', 'published'),
  ('11111111-1111-1111-1111-111111111111', 'pf-cafe',
    '{"en":"Cafe Rebrand","ar":"إعادة هوية مقهى"}', '{"en":"identity","ar":"تصميم العلامة"}', 'published');

-- Negative fixtures: a DRAFT (never visible) and a published OTHER-tenant row (cross-tenant=0).
insert into public.services (tenant_id, slug, title, blurb, status) values
  ('11111111-1111-1111-1111-111111111111', 'svc-secret-draft',
    '{"en":"Secretwidget","ar":"ودجتسري"}', '{"en":"","ar":""}', 'draft'),
  ('22222222-2222-2222-2222-222222222222', 'svc-other-tenant',
    '{"en":"Otherbrand","ar":"الهوية"}', '{"en":"","ar":""}', 'published');

-- ── normalization unit assertions ──────────────────────────────────────────
select is(app.normalize_ar('الإعلانات'), 'الاعلانات', 'normalize_ar: alef-hamza → bare alef');
select is(app.normalize_ar('الموسيقى'), 'الموسيقي', 'normalize_ar: alef-maqsura → ya');
select is(app.normalize_ar_q('هوية'), 'هويه', 'normalize_ar_q: ta-marbuta → ha');
select is(app.normalize_ar_q('الهَوِيَّة'), 'الهويه', 'normalize_ar_q: strips tashkeel + ta-marbuta→ha');

-- ── anon context (the public search path) ──────────────────────────────────
set local role anon;
select _claims(null, null);

-- ── recall@5 over ≥30 curated AR pairs (every normalization class) ──────────
-- ta-marbuta (ة): source has ة, queries come bare/with-ha/with-article
select ok(_recall('هوية', 'ar', 'svc-branding'), 'AR ta-marbuta bare: هوية → branding');
select ok(_recall('هويه', 'ar', 'svc-branding'), 'AR ta-marbuta as-ha: هويه → branding');
select ok(_recall('الهوية', 'ar', 'svc-branding'), 'AR article: الهوية → branding');
select ok(_recall('البصرية', 'ar', 'svc-branding'), 'AR: البصرية → branding');
select ok(_recall('أنظمة', 'ar', 'svc-branding'), 'AR blurb: أنظمة → branding');
-- alef variants (أ إ آ → ا)
select ok(_recall('إعلانات', 'ar', 'svc-advertising'), 'AR alef-hamza: إعلانات → advertising');
select ok(_recall('اعلانات', 'ar', 'svc-advertising'), 'AR bare-alef: اعلانات → advertising');
select ok(_recall('الإعلانات', 'ar', 'svc-advertising'), 'AR alef+article: الإعلانات → advertising');
select ok(_recall('حملات', 'ar', 'svc-advertising'), 'AR blurb: حملات → advertising');
select ok(_recall('إعلانية', 'ar', 'svc-advertising'), 'AR blurb: إعلانية → advertising');
-- alef-maqsura (ى ↔ ي)
select ok(_recall('الموسيقى', 'ar', 'svc-music'), 'AR maqsura source: الموسيقى → music');
select ok(_recall('الموسيقي', 'ar', 'svc-music'), 'AR maqsura→ya: الموسيقي → music');
select ok(_recall('موسيقى', 'ar', 'svc-music'), 'AR maqsura bare: موسيقى → music');
select ok(_recall('تلحين', 'ar', 'svc-music'), 'AR blurb: تلحين → music');
-- definite article + plain nouns
select ok(_recall('التصوير', 'ar', 'svc-photography'), 'AR article: التصوير → photography');
select ok(_recall('تصوير', 'ar', 'svc-photography'), 'AR bare: تصوير → photography');
select ok(_recall('الفوتوغرافي', 'ar', 'svc-photography'), 'AR: الفوتوغرافي → photography');
select ok(_recall('صور', 'ar', 'svc-photography'), 'AR blurb: صور → photography');
select ok(_recall('احترافية', 'ar', 'svc-photography'), 'AR blurb: احترافية → photography');
-- tatweel/kashida (source تصــوير → bare query must match)
select ok(_recall('تصوير', 'ar', 'svc-video'), 'AR tatweel: bare تصوير → video (kashida stripped)');
select ok(_recall('الفيديو', 'ar', 'svc-video'), 'AR: الفيديو → video');
select ok(_recall('إنتاج', 'ar', 'svc-video'), 'AR: إنتاج → video');
select ok(_recall('سينمائي', 'ar', 'svc-video'), 'AR blurb: سينمائي → video');
-- montage
select ok(_recall('المونتاج', 'ar', 'svc-montage'), 'AR: المونتاج → montage');
select ok(_recall('مونتاج', 'ar', 'svc-montage'), 'AR bare: مونتاج → montage');
select ok(_recall('لقطات', 'ar', 'svc-montage'), 'AR blurb: لقطات → montage');
-- portfolio
select ok(_recall('الرياض', 'ar', 'pf-riyadh'), 'AR: الرياض → riyadh');
select ok(_recall('موسم', 'ar', 'pf-riyadh'), 'AR: موسم → riyadh');
select ok(_recall('متكاملة', 'ar', 'pf-riyadh'), 'AR summary: متكاملة → riyadh');
select ok(_recall('مقهى', 'ar', 'pf-cafe'), 'AR maqsura: مقهى → cafe');
select ok(_recall('إعادة', 'ar', 'pf-cafe'), 'AR: إعادة → cafe');
select ok(_recall('تصميم', 'ar', 'pf-cafe'), 'AR summary: تصميم → cafe');
-- EN control pairs
select ok(_recall('branding', 'en', 'svc-branding'), 'EN: branding → branding');
select ok(_recall('advertising', 'en', 'svc-advertising'), 'EN: advertising → advertising');
select ok(_recall('riyadh', 'en', 'pf-riyadh'), 'EN: riyadh → riyadh');

-- ── zero zero-result: a representative curated query is non-empty ───────────
select cmp_ok((select count(*) from public.search_content('هوية', 'ar'))::int, '>=', 1,
  'AR zero-result guard: هوية returns ≥1 hit');

-- ── tenant + published fence (Pillar 1) ────────────────────────────────────
select is((select count(*) from public.search_content('Secretwidget', 'en'))::int, 0,
  'anon search excludes DRAFT rows (RLS inside SECURITY INVOKER)');
select ok(
  not exists (select 1 from public.search_content('هوية', 'ar') where slug = 'svc-other-tenant'),
  'anon search excludes OTHER-tenant rows (cross-tenant = 0)');

-- ── tsquery-injection / metacharacter + bounds safety ──────────────────────
select lives_ok($$ select * from public.search_content('a & b | c ! (d):*', 'en') $$,
  'tsquery metacharacters handled as text (no syntax error)');
select lives_ok($$ select * from public.search_content(repeat('x', 64), 'en') $$,
  'max-length query handled');
select lives_ok($$ select * from public.search_content('', 'en') $$,
  'empty query returns cleanly (early return, no scan)');
select lives_ok($$ select * from public.search_content('تصميم & "موشن" | (جرافيك):*', 'ar') $$,
  'AR query with tsquery metacharacters handled as text');

reset role;
select _claims(null, null);
select * from finish();
rollback;
