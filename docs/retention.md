# Data retention — proposed horizons for legal sign-off (KAN-22)

> **Status: awaiting sign-off.** The machinery is implemented and settings-driven
> (`supabase/migrations/0008_retention_jobs.sql`); only the *numbers* need approval.
> Per CLAUDE.md the raw-telemetry horizon **may go shorter, never longer**.
> Jurisdiction: **Saudi Arabia — PDPL applies.**

## How to change a horizon (no deploy needed)

Every horizon is stored in the single source `public.site_settings.retention` (jsonb).
Change the value and the nightly job follows it — there is deliberately **no second
hardcoded number** anywhere in code or SQL.

```sql
update public.site_settings
set retention = retention || jsonb_build_object('raw_telemetry_days', 60);
```

## Proposed horizons

| Data class | Table(s) | Proposed | Lawful basis / rationale | Risk if longer |
|---|---|---|---|---|
| Raw product telemetry (pageviews, CTA, search, service-interest) | `analytics_events` | **90 days** (`raw_telemetry_days`) | Consent (analytics). 90d covers quarter-over-quarter comparison; dashboards read `rollup_*`, which is unaffected by this purge. | Larger breach surface of behavioural data with no analytical gain — rollups already hold the long tail. |
| Web Vitals / RUM | `web_vitals` | **90 days** (`web_vitals_days`) | Consent (analytics). Matches CWV's own 28-day field window with margin for regression hunting. | Same as above; no business need. |
| Operational logs | `system_logs` | **30 days** (`system_logs_days`) | Legitimate interest (service operation). PII-scrubbed on write (`src/lib/log/scrub.ts`). 30d is enough to debug a reported incident. | Logs drift toward being an unindexed PII store. |
| Leads / enquiries | `leads` | **24 months** (`leads_months`) | Contract / pre-contract + consent for marketing. A creative-agency sales cycle plus repeat-project window. PII is envelope-encrypted at rest. | Encrypted, but still the highest-value target in the system. Shorten if sales says 12–18 months suffices. |
| Spam / rejected submissions | `leads` (flagged) | **30 days** (`spam_days`) | Legitimate interest (abuse prevention). | No reason to keep rejected junk containing third-party PII. |
| Job applications (Join) | `job_applications` + the CV in the private Storage bucket `applications` | **12 months** from receipt; **24 months** when the applicant ticked "contact me about future roles" | Consent (recruitment, `packages/consent/recruitment.ts`), shown at submission and stored on the row with its version. The horizon is part of what the applicant agreed to, so it is a **code constant** (`APPLICATION_RETENTION_MONTHS`, `packages/schemas/application.ts`), changed only with the notice and its version — not a `site_settings` value (Developer writes those, and Developer has no access to applications, owner decision J6). | CVs carry the most personal data the site holds (history, address, sometimes a photo). |
| Spam applications | `job_applications` (status `spam`) | **30 days** from the moment marked (`SPAM_RETENTION_DAYS`, applied by the 0029 trigger; a test keeps the two equal) — never longer than the original horizon | Legitimate interest (abuse prevention). | Third-party data with no purpose. |
| Public write counters | `public_write_attempts` | **48 hours** | Legitimate interest (abuse prevention, EXC-004). Keys are HMACs of the IP / e-mail, never the values. | None useful — a window is at most a day. |
| Audit log | `audit_log` | **Never auto-dropped** | Accountability/integrity. Append-only + HMAC hash-chained; dropping rows would break the chain and the R2 anchor. | n/a — deletion is the risk here, not retention. |
| Consent records | `consent_log` | **Retain while consent is relied upon + 24 months** | PDPL requires demonstrating consent was obtained. Deleting these destroys the proof that the telemetry above was lawful. | n/a |

## Deletion mechanics

- **Telemetry** — monthly range partitions are **dropped whole** (`app.purge_telemetry`), not row-deleted: constant-time, no vacuum churn, and no partial-row residue. A partition is dropped only when its **entire month** precedes the cutoff. Every partition, the roll-forward's new ones included, is RLS `ENABLE`+`FORCE` with no policy and no grant to `public`/`anon`/`authenticated` (migration 0037): telemetry is written and read only through the parent tables, whose policies apply, and RLS does not affect dropping a partition.
- **Leads / logs** — row deletes scoped per tenant (`app.purge_leads`, `app.purge_system_logs`). Leads honour an explicit `retention_delete_after` when set (that's the DSAR/erasure path), otherwise `created_at + horizon`.
- **Schedule** — one nightly `pg_cron` job (`braiin-retention`, 03:17) calls `app.run_retention()`, which also rolls partitions forward 2 months ahead so writes never land in the undroppable default partition. Each run writes a summary to `system_logs`.
- **Job applications** — the horizon is a column, `retention_delete_after`, set when the application is stored (12 or 24 months) and shortened — never lengthened — when an Admin marks it spam. The Worker's daily cron (`src/worker.ts` `scheduled`, 03:23 UTC, `wrangler.jsonc` `triggers`) deletes expired CVs **from Storage first** and only then their rows, 200 a day oldest first; a failed object delete leaves the rows for the next run, so no CV is ever left without the row that expires it. (A SQL `delete` on `storage.objects` would not delete the file — only the Storage API does — which is why this job is the Worker's, not `pg_cron`'s.) Then it sweeps **orphans** — CV objects no row names (the Worker stopped between an upload and its insert, or a compensating delete failed), older than an hour so an upload still being stored is never one (`public.application_orphan_cvs()`, service role only) — and deletes them the same way. The same job drops limiter counters older than 48 h. Each run writes its counts to `system_logs` (`cron:retention`). Erasure on request (DSAR): Admin → Job applications → **Erase**, in the same order.
- **Multi-tenant safety** — partitions are physically shared, so the telemetry purge uses the **longest** horizon across tenants; no tenant loses data early because another chose shorter.

## Still to decide (your call)

1. **Confirm or shorten** each proposed horizon above. Shorter is always acceptable; longer needs a documented justification per PDPL data-minimisation.
2. **DSAR / erasure SLA** — the mechanism exists (`retention_delete_after`), but the *response window* (PDPL expects without undue delay; 30 days is the common commitment) needs stating in the privacy policy.
3. **Legal copy** — `src/lib/legal/content.ts` currently carries a draft notice. Once horizons are signed off, the privacy policy should state them plainly (EN + AR) along with the cookie inventory and withdrawal path.

## Sign-off

| | Name | Date |
|---|---|---|
| Proposed by | Engineering | 2026-07-20 |
| Approved by | _(legal/DPO)_ | _(pending)_ |

Once approved: update `site_settings.retention` if any number changed, replace the draft
notice in the legal pages, and move **KAN-22** to Done.
