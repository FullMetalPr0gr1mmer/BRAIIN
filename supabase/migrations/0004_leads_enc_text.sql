-- 0004 — store encrypted lead PII as base64 text (AES-256-GCM ciphertext from the app
-- layer), not bytea. Forward-only; the table is empty so the USING cast is a no-op.
-- Decryption remains the role-checked gate of record (Admin/Developer) in the app.

alter table public.leads alter column email_enc type text using encode(email_enc, 'base64');
alter table public.leads alter column phone_enc type text using encode(phone_enc, 'base64');
alter table public.leads alter column budget_enc type text using encode(budget_enc, 'base64');
