-- ─────────────────────────────────────────────────────────────────────────────
-- 0006 — Unified cross-entity search (KAN-29). Postgres FTS v1, swap-ready behind
-- ONE accessor (public.search_content). Reuses app.ar_tsvector / app.normalize_ar
-- from 0003 — AR query is normalized the SAME way the generated search_ar columns are.
--
-- SECURITY INVOKER: the functions run under the CALLER's RLS, so the existing per-table
-- read policies (tenant = app.effective_tenant_id() AND published-or-staff) are the
-- SINGLE tenant+published fence — no hand-rolled predicate to drift. Anon → published,
-- single launch tenant. We still add `status='published'` belt-and-suspenders.
--
-- The two RPCs live in `public` (not `app`) because PostgREST only exposes `public` via
-- .rpc(); the app.* helpers stay private. Query parsing: websearch_to_tsquery ONLY
-- (never raw to_tsquery). Per-call statement_timeout. Capped rows via LIMIT.
-- Forward-only (expand): adds portfolio search columns + trigram indexes + functions.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- Portfolio search columns (services + blog already have them: 0001/0003) ----
alter table public.portfolio
  add column if not exists search_en tsvector generated always as (
    to_tsvector('english', coalesce(title ->> 'en', '') || ' ' || coalesce(summary ->> 'en', ''))
  ) stored,
  add column if not exists search_ar tsvector generated always as (
    app.ar_tsvector(coalesce(title ->> 'ar', '') || ' ' || coalesce(summary ->> 'ar', ''))
  ) stored;
create index if not exists portfolio_search_en_idx on public.portfolio using gin (search_en);
create index if not exists portfolio_search_ar_idx on public.portfolio using gin (search_ar);

-- ---- Query-side AR normalization: MUST mirror app.ar_tsvector's text step ---------
-- The generated search_ar columns are app.ar_tsvector(t) = to_tsvector('arabic',
-- normalize_ar(ta-marbuta→ha(t))). The search query must apply the SAME text transform
-- (ة→ه THEN normalize_ar) before websearch_to_tsquery, or ta-marbuta queries miss.
-- Single source of truth so the two sides can never drift. IMMUTABLE → index-usable.
create or replace function app.normalize_ar_q(t text) returns text
  language sql immutable strict as $$
  select app.normalize_ar(replace(coalesce($1, ''), 'ة', 'ه'))
$$;

-- ---- pg_trgm indexes for did-you-mean (extension already enabled: 0001) ----------
create index if not exists services_title_en_trgm
  on public.services using gin ((coalesce(title ->> 'en', '')) gin_trgm_ops);
create index if not exists services_title_ar_trgm
  on public.services using gin ((app.normalize_ar_q(coalesce(title ->> 'ar', ''))) gin_trgm_ops);
create index if not exists portfolio_title_en_trgm
  on public.portfolio using gin ((coalesce(title ->> 'en', '')) gin_trgm_ops);
create index if not exists portfolio_title_ar_trgm
  on public.portfolio using gin ((app.normalize_ar_q(coalesce(title ->> 'ar', ''))) gin_trgm_ops);
create index if not exists blog_title_en_trgm
  on public.blog_posts using gin ((coalesce(title ->> 'en', '')) gin_trgm_ops);
create index if not exists blog_title_ar_trgm
  on public.blog_posts using gin ((app.normalize_ar_q(coalesce(title ->> 'ar', ''))) gin_trgm_ops);

-- ---- THE single accessor: unified cross-entity full-text search ---------------
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
      case when is_ar then 'arabic' else 'english' end,
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

-- ---- Did-you-mean: trigram similarity over published titles (zero-result path) ---
create or replace function public.search_suggest(query text, locale text default 'en')
  returns table (entity_type text, slug text, title jsonb, similarity real)
  language sql
  stable
  security invoker
  set statement_timeout = '500ms'
  set search_path = public, app
as $$
  with norm as (
    select case when locale = 'ar' then app.normalize_ar_q(coalesce(query, ''))
                else coalesce(query, '') end as q
  )
  select * from (
    select 'service'::text as entity_type, s.slug, s.title,
           similarity(case when locale = 'ar' then app.normalize_ar_q(coalesce(s.title ->> 'ar', ''))
                           else coalesce(s.title ->> 'en', '') end, (select q from norm)) as similarity
    from public.services s where s.status = 'published'
    union all
    select 'portfolio', p.slug, p.title,
           similarity(case when locale = 'ar' then app.normalize_ar_q(coalesce(p.title ->> 'ar', ''))
                           else coalesce(p.title ->> 'en', '') end, (select q from norm))
    from public.portfolio p where p.status = 'published'
    union all
    select 'blog', b.slug, b.title,
           similarity(case when locale = 'ar' then app.normalize_ar_q(coalesce(b.title ->> 'ar', ''))
                           else coalesce(b.title ->> 'en', '') end, (select q from norm))
    from public.blog_posts b where b.status = 'published'
  ) cand(entity_type, slug, title, similarity)
  where cand.similarity > 0.15
  order by cand.similarity desc
  limit 3;
$$;

-- Anon + authenticated may call both; RLS still filters rows inside (SECURITY INVOKER).
grant execute on function public.search_content(text, text) to anon, authenticated;
grant execute on function public.search_suggest(text, text) to anon, authenticated;
