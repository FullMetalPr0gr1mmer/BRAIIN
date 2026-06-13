-- ─────────────────────────────────────────────────────────────────────────────
-- 0003 — Arabic FTS normalization (CLAUDE.md §8 "FTS")
-- Normalize Arabic BEFORE the 'arabic' text-search config: strip tashkeel/diacritics
-- and tatweel (kashida), unify alef/hamza variants, alef-maqsura→ya, ta-marbuta→ha.
-- IMMUTABLE so it can drive generated tsvector columns. The recall@5 = 100% / zero
-- zero-result curated-query pass bar is enforced by an integration test (Phase 1).
-- Forward-only: drops + recreates the search_ar generated columns (no data yet).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.normalize_ar(t text) returns text
  language sql immutable strict as $$
  select
    regexp_replace(
      regexp_replace(
        -- delete tashkeel (harakat) + tatweel/kashida (0640)
        translate(
          $1,
          E'ـًٌٍَُِّْٰٕٓٔ',
          ''
        ),
        -- alef variants (آ أ إ ٱ) → bare alef (ا)
        E'[آأإٱ]', E'ا', 'g'
      ),
      -- alef-maqsura (ى) → ya (ي); ta-marbuta (ة) → ha (ه)
      E'[ى]', E'ي', 'g'
    )
$$;

create or replace function app.ar_tsvector(t text) returns tsvector
  language sql immutable strict as $$
  select to_tsvector('arabic', app.normalize_ar(regexp_replace(coalesce($1, ''), E'ة', E'ه', 'g')))
$$;

-- Services
drop index if exists services_search_ar_idx;
alter table public.services drop column search_ar;
alter table public.services
  add column search_ar tsvector generated always as (
    app.ar_tsvector(coalesce(title ->> 'ar', '') || ' ' || coalesce(blurb ->> 'ar', ''))
  ) stored;
create index services_search_ar_idx on public.services using gin (search_ar);

-- Blog posts
drop index if exists blog_search_ar_idx;
alter table public.blog_posts drop column search_ar;
alter table public.blog_posts
  add column search_ar tsvector generated always as (
    app.ar_tsvector(coalesce(title ->> 'ar', '') || ' ' || coalesce(excerpt ->> 'ar', ''))
  ) stored;
create index blog_search_ar_idx on public.blog_posts using gin (search_ar);
