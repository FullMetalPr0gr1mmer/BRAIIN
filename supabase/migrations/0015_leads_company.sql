-- 0015 — `company` on leads (contact page redesign)
--
-- The redesigned /contact form collects a company name. It is business-contact data
-- attached to a business enquiry, NOT one of the four columns CLAUDE.md §3 gates to
-- Admin + Developer (budget_enc / timeline_band / internal_notes / ip_inet). It
-- therefore belongs IN `leads_safe`, and must not be added to SENSITIVE_LEAD_COLUMNS —
-- quietly extending that documented list from a migration is how a gating story stops
-- matching its own documentation.
--
-- Forward-only, expand/contract: the column is nullable, so this is additive and every
-- existing row and code path keeps working before the application half ships.

alter table public.leads
  add column if not exists company text;

comment on column public.leads.company is
  'Optional company/organisation from the public contact form. Non-sensitive: exposed '
  'via leads_safe to every lead-viewing role. Bounded to 120 chars by LeadInputSchema.';

-- ---- leads_safe: re-created to carry the new column --------------------------------
--
-- `with (security_invoker = true)` MUST be repeated here. It is not inherited by
-- `create or replace view`: re-issuing the definition without the clause resets the
-- view to DEFINER rights, and because 0002 grants `select on public.leads_safe to
-- authenticated`, a definer-rights view would hand every authenticated user — Content
-- Creator and SEO included, who are supposed to have NO lead access at all — a readable
-- window onto every tenant's leads, straight through the RLS on the base table.
--
-- This single clause is the highest-severity line in this migration. The pgTAP suite
-- asserts it against pg_class.reloptions so a future edit cannot drop it silently.
create or replace view public.leads_safe with (security_invoker = true) as
select
  id, tenant_id, kind, locale, name, company, message, service_of_interest,
  status, consent_marketing, created_at, updated_at
from public.leads;

revoke all on public.leads_safe from anon;
grant select on public.leads_safe to authenticated;
