-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0092 — The Sales role, part A: the enum value, alone (Admin v2 C10a, owner decision A4,
-- README P-13). Forward-only, expand only. Depends on 0001 (public.app_role).
--
-- PostgreSQL allows ALTER TYPE … ADD VALUE inside a transaction (12 and later), but the new
-- value cannot be USED until that transaction commits: casting to it, comparing with it or
-- storing it raises 55P04 ("unsafe use of new enum value"). The Supabase CLI runs each
-- migration file in its own transaction, so this file holds the one statement and nothing
-- else, and every use of 'sales' is in 0093, the next file. A toolchain that ever batched
-- both files into one transaction would fail loudly on 0093's first use of the value, never
-- silently; apply them one at a time then.
--
-- An enum value cannot be dropped. Rolling the role back means demoting every Sales user
-- and leaving the value unused: no policy or helper grants it anything until 0093 names it
-- (CLAUDE.md §5, "when in doubt, default-deny").
-- ─────────────────────────────────────────────────────────────────────────────────────────

alter type public.app_role add value if not exists 'sales';
