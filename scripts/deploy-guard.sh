#!/usr/bin/env bash
# Pre-deploy guard: refuse to ship code whose migrations production has not applied.
#
# Merging to main auto-deploys the Worker (.github/workflows/ci.yml `deploy`), but
# migrations are applied by hand (`supabase db push`, launch runbook). If code that reads
# a new column ships first, the loader's select fails — and the loaders fail CLOSED to
# `[]`, so the symptom is not an error page but content silently vanishing (every service
# page 404ing, the contact form 500ing on an unknown insert column).
#
# Checks, against production, with a least-privilege read-only role (runbook §5a):
#   0. the connection is the `deploy_guard` role, over TLS verified against Supabase's root
#      CA (scripts/certs/supabase-root-2021-ca.crt) — never an unverified server, never a
#      privileged URL;
#   1. every migration version in supabase/migrations is recorded in
#      supabase_migrations.schema_migrations;
#   2. once migration 0016 exists, the `app.deployment` marker reads 'production' — the
#      switch that arms the production-only placeholder publish guard and makes
#      supabase/seed.sql refuse to run there.
#
# Requires SUPABASE_GUARD_DB_URL: a bare postgresql:// URL for the `deploy_guard` role on the
# session pooler (:5432), no query string — the TLS mode, root CA and connect timeout are
# pinned here. Fails closed on anything it cannot check. Runs in ci.yml's `deploy` job (before
# `npm ci`) and, read-only against production, in `deploy-guard-preview` on the owner's PRs.
set -euo pipefail

fail() {
  echo "::error::$*"
  exit 1
}

[[ -n "${SUPABASE_GUARD_DB_URL:-}" ]] ||
  fail "SUPABASE_GUARD_DB_URL is empty: refusing to deploy unchecked (runbook §5a)."
[[ "$SUPABASE_GUARD_DB_URL" == postgresql://* || "$SUPABASE_GUARD_DB_URL" == postgres://* ]] ||
  fail "SUPABASE_GUARD_DB_URL must be a postgresql:// URL (runbook §5a)."
[[ "$SUPABASE_GUARD_DB_URL" != *\?* ]] ||
  fail "SUPABASE_GUARD_DB_URL must have no query string: TLS and timeouts are pinned here (runbook §5a)."
command -v psql >/dev/null 2>&1 || fail "psql is not installed on this runner."

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The pooler's certificate chain ends at Supabase's PRIVATE root (no public CA vouches for
# it), and Supavisor asks for the password in cleartext inside TLS: verifying the server
# against this root is what keeps the password from an impostor. Connection parameters in a
# URL (or a key=value string) would override these PG* variables — hence the refusals above.
export PGSSLMODE=verify-full PGSSLROOTCERT="$here/certs/supabase-root-2021-ca.crt"
export PGCONNECT_TIMEOUT=10 PGAPPNAME=deploy-guard
[[ -s "$PGSSLROOTCERT" ]] || fail "missing $PGSSLROOTCERT"

q() { psql "$SUPABASE_GUARD_DB_URL" -X -v ON_ERROR_STOP=1 -At -c "$1"; }

who="$(q "select current_user")" ||
  fail "cannot connect to production as the guard role (psql's message above)."
[[ "$who" == deploy_guard ]] ||
  fail "connected as '$who', not deploy_guard: never a privileged URL (runbook §5a)."
echo "✓ connected as deploy_guard (TLS verified against the Supabase root CA)."

applied="$(q "select version from supabase_migrations.schema_migrations order by version")"

missing=()
for f in supabase/migrations/*.sql; do
  v="$(basename "$f" | cut -d_ -f1)"
  grep -qx "$v" <<<"$applied" || missing+=("$(basename "$f")")
done

if ((${#missing[@]})); then
  echo "::error::Production is missing ${#missing[@]} migration(s): ${missing[*]}"
  echo "Apply them first (supabase db push — launch runbook), then re-run this job."
  exit 1
fi
echo "✓ production has every migration in the repo ($(wc -l <<<"$applied") applied)."

if [[ "$(q "select to_regclass('app.deployment') is not null")" == "t" ]]; then
  env_marker="$(q "select coalesce((select env from app.deployment limit 1), '<unset>')")"
  if [[ "$env_marker" != "production" ]]; then
    echo "::error::app.deployment is '$env_marker', expected 'production' (runbook: set it right after applying 0016)."
    exit 1
  fi
  echo "✓ app.deployment = production."
elif [[ -e supabase/migrations/0016_page_sections_public.sql ]]; then
  echo "::error::0016 is in the repo but app.deployment is not readable — grant it to deploy_guard (runbook §5a)."
  exit 1
fi
