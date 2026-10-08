# C1b: how a lead arrives

- **Lane:** CRM
- **Design:** [crm.md](../crm.md) §6, §7.1 and CRM-1 (the ingest half)
- **PR:** #46, folded into #45 (merged as `aa7cf76` on 2026-10-08)
- **Migrations:** 0035 (`0035_crm_ingest.sql`), expand

## Departures from the design, and why

- **Its own migration.** CRM-1's ingest half shipped as 0035, after the pipeline (0034).
- **`public.crm_ingest_lead`** (service role only, SECURITY INVOKER) takes an allow-listed
  jsonb and the Worker's own id, so a retry after a lost response is a no-op and spends no lead
  number; the database adds the `returning` signal and the score, in one transaction with the
  timeline's created event. It sets `crm_indexed_at` only when the Worker sent the index
  payload, so an unindexed arrival waits for the cron.
- **`createLead`** normalises and blind-indexes e-mail and phone (HMAC under the labelled
  `crm-index/v1` derivation of `LEAD_PII_ENC_KEY`, tenant-salted; no new secret), works out the
  score signals from the plaintext before encrypting, and calls the RPC. It falls back to the
  plain insert only when the RPC is unavailable (PGRST202, 42883, no answer); a real refusal is
  reported, never retried, and a duplicate id on the fallback counts as success.
- **`crm_settings`**, one row per tenant (scoring points, response target, time zone), read by
  lead workers; new tenants get one. Editing arrives with CRM settings.
- **Columns.** `email_hmac`, `phone_hmac` and `score_signals` are never readable by staff;
  `score`, `source` and `channel` are. `email_enc` is optional, with "at least one channel".
- **The daily indexing** runs in batches of 20, not the design's 500: with every step at its
  worst, a run then uses 35 of the Workers Free plan's 50 subrequests, and the cheap purges run
  first. Each field is decrypted on its own, so a corrupt budget no longer costs the e-mail and
  phone indexes. When nothing in a batch decrypts, the key is wrong: the run writes nothing and
  says so once. A lead with an unreadable field is still indexed with what could be read, so it
  never blocks the queue. The `cron:crm-index` log line is written on every run, a partial or
  failed one included.
- **`timeline_band`** is no longer written in plaintext; the cron moves legacy values into the
  encrypted timeline.
- **`hmacHex`** moved to `src/lib/crypto/hmac.ts` (re-exported from the limiter).
- **Tests.** pgTAP `crm_ingest.test.sql`; unit specs for normalisation, blind indexes, signals
  and score (with SQL parity), `createLead`'s RPC and fallback rules and its payload against
  0035's allow-list, the backfill, and `dailyJobs.spec`, which runs the daily jobs for real on
  a stub client.
