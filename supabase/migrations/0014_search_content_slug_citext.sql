-- ─────────────────────────────────────────────────────────────────────────────
-- 0014 — The third bug in search_content(), reachable only once 0013 fixed the second.
--
-- 0013 fixed the `ts_headline` regconfig cast, and the very next call to the live
-- function returned:
--
--     42804  Returned type citext does not match expected type text in column 2
--
-- Column 2 is `slug`. `services.slug`, `portfolio.slug` and `blog_posts.slug` are all
-- `citext` — that is deliberate and stated in CLAUDE.md §8 ("citext slugs/emails") — but
-- the function's RETURNS TABLE declares `slug text`. plpgsql's `return query` requires an
-- EXACT type match on every column; unlike a plain SQL cast site, it will not coerce
-- citext→text for you even though the two are assignment-compatible.
--
-- Why this is the third one and not a surprise: each of these errors is raised by the
-- executor, one statement at a time, so a body cannot report more than its first failure.
-- 0006 shipped with all three latent, 0013 cleared the one in front, and this is what was
-- standing behind it. The lesson is not "we missed a cast" — it is that a plpgsql function
-- with no test that CALLS it is unverified no matter how many times it has been read.
-- `supabase/tests/search_content.test.sql` (added alongside this migration) executes the
-- function and asserts on rows, which is the only shape of test that could have caught
-- any of the three.
--
-- The cast goes on all three UNION branches rather than on the final select. A UNION ALL
-- takes its column type from the FIRST branch, so casting only there would also work —
-- and would silently break the day someone reorders the branches. Casting each one makes
-- the CTE's declared shape match the function's, which is the invariant that actually
-- matters.
--
-- Body is 0013's, unchanged, except for the three `::text` casts marked below.
-- Forward-only. `create or replace` preserves the ACL; re-asserted anyway.
-- CLAUDE.md §3 (Pillar 1), §8 (FTS), §9.
-- ─────────────────────────────────────────────────────────────────────────────

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
    select 'service'::text as entity_type, s.slug::text as slug, s.title,   -- 0014: ::text
           case when is_ar then coalesce(s.title ->> 'ar', '') || ' ' || coalesce(s.blurb ->> 'ar', '')
                else coalesce(s.title ->> 'en', '') || ' ' || coalesce(s.blurb ->> 'en', '') end as src,
           case when is_ar then ts_rank(s.search_ar, q_ar) else ts_rank(s.search_en, q_en) end as rank
    from public.services s
    where s.status = 'published'
      and (case when is_ar then s.search_ar @@ q_ar else s.search_en @@ q_en end)
    union all
    select 'portfolio', p.slug::text, p.title,                              -- 0014: ::text
           case when is_ar then coalesce(p.title ->> 'ar', '') || ' ' || coalesce(p.summary ->> 'ar', '')
                else coalesce(p.title ->> 'en', '') || ' ' || coalesce(p.summary ->> 'en', '') end,
           case when is_ar then ts_rank(p.search_ar, q_ar) else ts_rank(p.search_en, q_en) end
    from public.portfolio p
    where p.status = 'published'
      and (case when is_ar then p.search_ar @@ q_ar else p.search_en @@ q_en end)
    union all
    select 'blog', b.slug::text, b.title,                                   -- 0014: ::text
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
      (case when is_ar then 'arabic' else 'english' end)::regconfig,   -- 0013
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
grant execute on function public.search_content(text, text) to anon, authenticated, service_role;

-- ---- Postcondition: CALL it, do not merely define it -----------------------
-- Every one of the three bugs in this function was invisible to `create or replace`,
-- which only parses. All three raised at EXECUTION. So this migration refuses to succeed
-- without executing the function in both locales — the cheapest possible version of the
-- test whose absence is the actual root cause here.
do $$
declare
  v_count int;
begin
  perform * from public.search_content('brand', 'en');
  get diagnostics v_count = row_count;
  raise notice 'search_content(en) executed, % row(s)', v_count;

  perform * from public.search_content('هوية', 'ar');
  get diagnostics v_count = row_count;
  raise notice 'search_content(ar) executed, % row(s)', v_count;

  -- An empty query must short-circuit rather than scan.
  perform * from public.search_content('', 'en');
exception
  when others then
    raise exception 'search_content still raises on execution: % (%)', sqlerrm, sqlstate;
end $$;
