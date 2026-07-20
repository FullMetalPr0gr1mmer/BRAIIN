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
| Audit log | `audit_log` | **Never auto-dropped** | Accountability/integrity. Append-only + HMAC hash-chained; dropping rows would break the chain and the R2 anchor. | n/a — deletion is the risk here, not retention. |
| Consent records | `consent_log` | **Retain while consent is relied upon + 24 months** | PDPL requires demonstrating consent was obtained. Deleting these destroys the proof that the telemetry above was lawful. | n/a |

## Deletion mechanics

- **Telemetry** — monthly range partitions are **dropped whole** (`app.purge_telemetry`), not row-deleted: constant-time, no vacuum churn, and no partial-row residue. A partition is dropped only when its **entire month** precedes the cutoff.
- **Leads / logs** — row deletes scoped per tenant (`app.purge_leads`, `app.purge_system_logs`). Leads honour an explicit `retention_delete_after` when set (that's the DSAR/erasure path), otherwise `created_at + horizon`.
- **Schedule** — one nightly `pg_cron` job (`braiin-retention`, 03:17) calls `app.run_retention()`, which also rolls partitions forward 2 months ahead so writes never land in the undroppable default partition. Each run writes a summary to `system_logs`.
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
