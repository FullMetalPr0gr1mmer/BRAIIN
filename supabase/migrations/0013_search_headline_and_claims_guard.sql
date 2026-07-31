-- ─────────────────────────────────────────────────────────────────────────────
-- 0013 — Two bugs the pgTAP suite found on its FIRST EVER run.
--
-- `.github/workflows/db-tests.yml` was `on: workflow_dispatch` from the day it was
-- written and had never executed once. Promoting it to push/PR immediately surfaced both
-- of these. Neither is exotic; both are the same shape as 0010 and 0012 — a name that
-- does not resolve, inside a plpgsql body, where nothing is checked until it runs.
--
--
-- 1. `public.search_content()` HAS NEVER WORKED.
--
--    ts_headline(
--      case when is_ar then 'arabic' else 'english' end,   -- ← this is `text`
--      h.src, ..., '...'
--    )
--
--    `ts_headline`'s config overload takes `regconfig`. A bare literal would coerce from
--    `unknown`, but a CASE expression has already resolved to `text`, and there is no
--    implicit text→regconfig cast — so every call raises
--    `function ts_headline(text, text, tsquery, unknown) does not exist`. The unified
--    search accessor is reached by `/api/search`, so anonymous search has been a 500 for
--    its entire existence. `search_suggest` (the did-you-mean path) does not call
--    ts_headline and was unaffected, which is why the endpoint half-worked.
--
--
-- 2. Every RLS helper throws if `request.jwt.claims` is an EMPTY STRING.
--
--    select nullif(current_setting('request.jwt.claims', true)::jsonb #>> '{...}', '')
--
--    The cast binds before the nullif, so `''::jsonb` raises `invalid input syntax for
--    type json`. PostgREST sends real JSON for both anon and authenticated, so production
--    never hit it — but the pgTAP harness sets the GUC to `''` to simulate "no claims",
--    which is why rls_services / rls_leads / rls_admin_cms all abort at their FIRST anon
--    assertion and report "Bad plan. You planned N tests but ran 0". Three whole RLS
--    suites were unrunnable, so the anon fence they exist to prove was never proven.
--
--    Guarding the empty string is also correct on its own terms: an unparseable GUC
--    should read as "no claims" and fall through to the anon fence, not raise inside
--    every policy on the database.
--
-- Forward-only. `create or replace` preserves each function's ACL, so 0011's grants and
-- revokes survive; re-asserted below anyway rather than left implicit.
-- CLAUDE.md §3 (Pillar 1), §8 (FTS), §9.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- 1. The claims guard ---------------------------------------------------
-- nullif() on the RAW SETTING, before the cast — that is the whole fix.
create or replace function app.current_tenant_id() returns uuid
  language sql stable as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb #>> '{app_metadata,tenant_id}',
    ''
  )::uuid
$$;

create or replace function app.current_role() returns text
  language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb #>> '{app_metadata,role}',
    'anon'
  )
$$;

-- ---- 2. search_content: cast the text-search config to regconfig -----------
-- Body is 0006's, unchanged, except for the `::regconfig` on line marked below.
create or replace function public.search_content(query text, locale text default 'en')
  returns table (entity_type text, slug text, title jsonb, snippet text, rank real)
  language plpgsql
  stable
  security invoker                    -- caller's RLS = the tenant+published fence
  set statement_timeout = '750ms'     -- per-call DB time ceiling (Pillar 1)
  set search_path = public, app
as $$
declare
  q_en  tsquery;
  q_ar  tsquery;
  is_ar boolean := (locale = 'ar');
begin
  -- websearch_to_tsquery NEVER raw to_tsquery; AR normalized first so the query
  -- tokenizes exactly like the generated search_ar column did.
  q_en := websearch_to_tsquery('english', coalesce(query, ''));
  q_ar := websearch_to_tsquery('arabic', app.normalize_ar_q(coalesce(query, '')));

  -- Empty/garbage query → return nothing (no table scan beyond the cheap parse).
  if (is_ar and q_ar = ''::tsquery) or (not is_ar and q_en = ''::tsquery) then
    return;
  end if;

  return query
  with hits as (
    select 'service'::text as entity_type, s.slug, s.title,
           case when is_ar then coalesce(s.title ->> 'ar', '') || ' ' || coalesce(s.blurb ->> 'ar', '')
                else coalesce(s.title ->> 'en', '') || ' ' || coalesce(s.blurb ->> 'en', '') end as src,
           case when is_ar then ts_rank(s.search_ar, q_ar) else ts_rank(s.search_en, q_en) end as rank
    from public.services s
    where s.status = 'published'
      and (case when is_ar then s.search_ar @@ q_ar else s.search_en @@ q_en end)
    union all
    select 'portfolio', p.slug, p.title,
           case when is_ar then coalesce(p.title ->> 'ar', '') || ' ' || coalesce(p.summary ->> 'ar', '')
                else coalesce(p.title ->> 'en', '') || ' ' || coalesce(p.summary ->> 'en', '') end,
           case when is_ar then ts_rank(p.search_ar, q_ar) else ts_rank(p.search_en, q_en) end
    from public.portfolio p
    where p.status = 'published'
      and (case when is_ar then p.search_ar @@ q_ar else p.search_en @@ q_en end)
    union all
    select 'blog', b.slug, b.title,
           case when is_ar then coalesce(b.title ->> 'ar', '') || ' ' || coalesce(b.excerpt ->> 'ar', '')
                else coalesce(b.title ->> 'en', '') || ' ' || coalesce(b.excerpt ->> 'en', '') end,
           case when is_ar then ts_rank(b.search_ar, q_ar) else ts_rank(b.search_en, q_en) end
    from public.blog_posts b
    where b.status = 'published'
      and (case when is_ar then b.search_ar @@ q_ar else b.search_en @@ q_en end)
  )
  select
    h.entity_type,
    h.slug,
    h.title,
    -- Plain-text snippet (empty Start/StopSel) so the client renders it as textContent
    -- with no markup — no innerHTML path, CSP-safe.
    ts_headline(
      (case when is_ar then 'arabic' else 'english' end)::regconfig,   -- 0013: the fix
      h.src,
      case when is_ar then q_ar else q_en end,
      'MaxFragments=1, MaxWords=20, MinWords=8, StartSel="", StopSel=""'
    ) as snippet,
    h.rank
  from hits h
  order by h.rank desc, h.entity_type, h.slug
  limit 20;                           -- capped rows (Pillar 1)
end;
$$;

-- ---- Re-assert the 0011 privilege posture ----------------------------------
grant execute on function app.current_tenant_id() to anon, authenticated, service_role;
grant execute on function app.current_role() to anon, authenticated, service_role;
grant execute on function public.search_content(text, text) to anon, authenticated, service_role;

-- ---- Prove both fixes in this transaction ----------------------------------
do $$
declare
  v_role text;
  v_snip text;
begin
  -- The claims guard: an empty GUC must read as "no claims", not raise.
  perform set_config('request.jwt.claims', '', true);
  v_role := app.current_role();
  if v_role is distinct from 'anon' then
    raise exception '0013 self-test: empty claims should resolve to anon, got %', v_role;
  end if;
  if app.current_tenant_id() is not null then
    raise exception '0013 self-test: empty claims should give a null tenant_id';
  end if;
  perform set_config('request.jwt.claims', '', true);

  -- ts_headline resolves with a regconfig-cast CASE.
  select ts_headline(
           (case when false then 'arabic' else 'english' end)::regconfig,
           'braiin station creative agency',
           websearch_to_tsquery('english', 'creative'),
           'MaxFragments=1, MaxWords=20, MinWords=8, StartSel="", StopSel=""'
         ) into v_snip;
  if v_snip is null or v_snip = '' then
    raise exception '0013 self-test: ts_headline returned nothing';
  end if;
end $$;
