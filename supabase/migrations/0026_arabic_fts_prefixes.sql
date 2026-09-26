-- ─────────────────────────────────────────────────────────────────────────────
-- 0026 — Arabic FTS: a query without "ال" now finds a title with it (CLAUDE.md §8 FTS gate).
--
-- The pgTAP gate (search_content.test.sql) has failed 5 of its curated pairs since it was
-- written: هوية / هويه → "الهوية البصرية", إعلانات / اعلانات → "الإعلانات", لقطات →
-- "مونتاج للقطات". Visitors see the same thing: /ar/search?q=هوية does not return
-- Branding, because the live title carries the article.
--
-- WHY — the Snowball Arabic stemmer decides a word's class from its article:
--   to_tsvector('arabic', 'الهويه')    → 'هويه'     definite → noun rules, no pronoun strip
--   to_tsvector('arabic', 'هويه')      → 'هوي'      bare → the final ه is read as "his"
--   to_tsvector('arabic', 'الاعلانات') → 'اعلان'    noun plural ات stripped
--   to_tsvector('arabic', 'اعلانات')   → 'اعلانا'   bare → verb rules, only ت stripped
-- So the same word stems two ways depending on whether it had "ال", and a visitor almost
-- never types the article. The ة→ه fold (0003) makes it worse: it turns every ta-marbuta
-- into the pronoun suffix the bare path strips.
--
-- FIX — take the article off before the stemmer sees the word, on BOTH sides, so the
-- two sides always hand it the same string (a deterministic stemmer then always agrees):
--   • ال and its clitic forms وال / فال / بال / كال, when ≥3 letters remain
--     (so الذي / التي stay whole and remain stopwords);
--   • لل ("for the", or ل before a word starting with ل — the spelling cannot tell which).
--     The index side emits BOTH readings (للقطات → "قطات لقطات"); the query side takes the
--     article reading. لقطات then finds "للقطات", and للعالم finds "العالم".
-- Word boundaries are "not an Arabic letter" (U+0621–U+064A), so websearch operators,
-- quotes, Latin words and digits pass through untouched.
--
-- One function, app.ar_fts_text(t, for_query), is the single definition both sides call —
-- the same single-source rule 0006 set for normalize_ar_q. normalize_ar / normalize_ar_q
-- are NOT changed: the trigram indexes (0006) are built on normalize_ar_q, and changing an
-- IMMUTABLE function under an expression index leaves the index stale.
--
-- Rebuild: search_ar is a STORED generated column, so replacing app.ar_tsvector does not
-- recompute existing rows. Postgres 15 (the local/CI major) has no ALTER COLUMN … SET
-- EXPRESSION, so each column is dropped and re-added, as 0003 did. No view, policy or
-- column grant references search_ar (checked: 0002/0009/0015/0017/0025 views name their
-- columns); the GIN indexes go with the column and are recreated. Table-level grants
-- cover the re-added column.
--
-- Verified before writing against a real Postgres (PGlite, PG 18 — same Snowball
-- stemmer): all 32 curated pairs plus و+ال / لل / بال / الل forms match.
-- Forward-only. CLAUDE.md §3 (Pillar 1: websearch_to_tsquery only), §8 (FTS), §9.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.ar_fts_text(t text, for_query boolean default false)
  returns text
  language sql immutable strict
as $$
  select regexp_replace(
           regexp_replace(
             app.normalize_ar_q($1),
             -- ال and its clitic forms, when ≥3 letters remain
             '(^|[^ء-ي])[وفبك]?ال([ء-ي]{3,})', '\1\2', 'g'),
           -- لل: the index keeps both readings, a query takes the article reading
           '(^|[^ء-ي])لل([ء-ي]{2,})',
           case when $2 then '\1\2' else '\1\2 ل\2' end, 'g')
$$;

comment on function app.ar_fts_text(text, boolean) is
  'Arabic FTS text step shared by the index (app.ar_tsvector) and the query '
  '(public.search_content): normalize_ar_q, then strip the definite article so the '
  'Snowball stemmer sees the same word on both sides. 0026.';

-- Reachable by anon through public.search_content (SECURITY INVOKER), exactly like
-- normalize_ar_q; the 0011 default-deny revokes PUBLIC, so grant explicitly.
revoke all on function app.ar_fts_text(text, boolean) from public;
grant execute on function app.ar_fts_text(text, boolean) to anon, authenticated, service_role;

create or replace function app.ar_tsvector(t text) returns tsvector
  language sql immutable strict as $$
  select to_tsvector('arabic', app.ar_fts_text(coalesce($1, '')))
$$;

-- ---- Rebuild the stored columns (expressions unchanged from 0003/0006) ------
drop index if exists services_search_ar_idx;
alter table public.services drop column search_ar;
alter table public.services
  add column search_ar tsvector generated always as (
    app.ar_tsvector(coalesce(title ->> 'ar', '') || ' ' || coalesce(blurb ->> 'ar', ''))
  ) stored;
create index services_search_ar_idx on public.services using gin (search_ar);

drop index if exists blog_search_ar_idx;
alter table public.blog_posts drop column search_ar;
alter table public.blog_posts
  add column search_ar tsvector generated always as (
    app.ar_tsvector(coalesce(title ->> 'ar', '') || ' ' || coalesce(excerpt ->> 'ar', ''))
  ) stored;
create index blog_search_ar_idx on public.blog_posts using gin (search_ar);

drop index if exists portfolio_search_ar_idx;
alter table public.portfolio drop column search_ar;
alter table public.portfolio
  add column search_ar tsvector generated always as (
    app.ar_tsvector(coalesce(title ->> 'ar', '') || ' ' || coalesce(summary ->> 'ar', ''))
  ) stored;
create index portfolio_search_ar_idx on public.portfolio using gin (search_ar);

-- ---- The query side: 0014's body, with the AR parse on app.ar_fts_text ------
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
  -- websearch_to_tsquery NEVER raw to_tsquery; the AR query goes through the SAME text
  -- step as the generated search_ar columns (0026: app.ar_fts_text).
  q_en := websearch_to_tsquery('english', coalesce(query, ''));
  q_ar := websearch_to_tsquery('arabic', app.ar_fts_text(coalesce(query, ''), true));

  -- Empty/garbage query → return nothing (no table scan beyond the cheap parse).
  if (is_ar and q_ar = ''::tsquery) or (not is_ar and q_en = ''::tsquery) then
    return;
  end if;

  return query
  with hits as (
    select 'service'::text as entity_type, s.slug::text as slug, s.title,
           case when is_ar then coalesce(s.title ->> 'ar', '') || ' ' || coalesce(s.blurb ->> 'ar', '')
                else coalesce(s.title ->> 'en', '') || ' ' || coalesce(s.blurb ->> 'en', '') end as src,
           case when is_ar then ts_rank(s.search_ar, q_ar) else ts_rank(s.search_en, q_en) end as rank
    from public.services s
    where s.status = 'published'
      and (case when is_ar then s.search_ar @@ q_ar else s.search_en @@ q_en end)
    union all
    select 'portfolio', p.slug::text, p.title,
           case when is_ar then coalesce(p.title ->> 'ar', '') || ' ' || coalesce(p.summary ->> 'ar', '')
                else coalesce(p.title ->> 'en', '') || ' ' || coalesce(p.summary ->> 'en', '') end,
           case when is_ar then ts_rank(p.search_ar, q_ar) else ts_rank(p.search_en, q_en) end
    from public.portfolio p
    where p.status = 'published'
      and (case when is_ar then p.search_ar @@ q_ar else p.search_en @@ q_en end)
    union all
    select 'blog', b.slug::text, b.title,
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
      (case when is_ar then 'arabic' else 'english' end)::regconfig,
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

grant execute on function public.search_content(text, text) to anon, authenticated, service_role;

-- ---- Postcondition: the stemmer agrees across the article, on THIS server ---
-- Runs against the host's own Snowball build, so a production Postgres that stems
-- differently fails the migration instead of shipping a silent recall regression.
do $$
declare
  v_pair text[];
begin
  foreach v_pair slice 1 in array array[
    ['الهَوِيَّة البصرية', 'هوية'],
    ['الهَوِيَّة البصرية', 'هويه'],
    ['الإعلانات',          'اعلانات'],
    ['مونتاج للقطات',      'لقطات'],
    ['موسم الرياض',        'الرياض']
  ] loop
    if not (app.ar_tsvector(v_pair[1])
            @@ websearch_to_tsquery('arabic', app.ar_fts_text(v_pair[2], true))) then
      raise exception 'Arabic FTS: query "%" does not match "%" after 0026', v_pair[2], v_pair[1];
    end if;
  end loop;

  perform * from public.search_content('هوية', 'ar');
  perform * from public.search_content('brand', 'en');
  perform * from public.search_content('', 'ar');
end $$;
