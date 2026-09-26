-- ─────────────────────────────────────────────────────────────────────────────
-- 0017 — Free-text project deadline on leads, encrypted and Admin/Developer-only.
-- Forward-only (expand). Depends on 0002, 0004, 0015. UI v2 PR1.
--
-- The new contact design asks "When do you need it?" as FREE TEXT ("A date, a season, or
-- ASAP") where the old form offered a four-value `timeline_band` select. CLAUDE.md §3
-- names `timeline` among the four lead fields restricted to Admin + Developer, so the
-- free text is sensitive by the same rule and is handled like `budget`:
--
--   * envelope-encrypted by the Worker (LEAD_PII_ENC_KEY, AES-256-GCM) — this column only
--     ever holds ciphertext;
--   * OMITTED from `leads_safe`. The view's column list is explicit (0015), so a column
--     added to the base table does not appear in it — and it is deliberately NOT
--     re-created here: `create or replace view` can only append, and the one thing this
--     column must never do is appear in the safe view;
--   * decrypted only on the role-checked detail/export path (src/lib/admin/leadFields.ts
--     SENSITIVE_LEAD_COLUMNS).
--
-- `timeline_band` stays: existing rows carry it, and the form keeps accepting it until
-- cached pages have turned over (plan: "legacy values accepted on input").
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.leads add column if not exists timeline_text_enc text;

comment on column public.leads.timeline_text_enc is
  'AES-256-GCM ciphertext (LEAD_PII_ENC_KEY) of the free-text "when do you need it" answer. '
  'CLAUDE.md §3 timeline field — Admin/Developer only; never in leads_safe.';

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads_safe' and column_name = 'timeline_text_enc'
  ) then
    raise exception 'timeline_text_enc must not appear in leads_safe';
  end if;
  if not (
    select coalesce(reloptions::text[] @> array['security_invoker=true'], false)
      from pg_class where relname = 'leads_safe' and relnamespace = 'public'::regnamespace
  ) then
    raise exception 'leads_safe lost security_invoker — every authenticated role would read all leads';
  end if;
  if has_table_privilege('anon', 'public.leads', 'select') then
    raise exception 'anon can select public.leads';
  end if;
end $$;
