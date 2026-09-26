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
#   1. every migration version in supabase/migrations is recorded in
#      supabase_migrations.schema_migrations;
#   2. once migration 0016 exists, the `app.deployment` marker reads 'production' — the
#      switch that arms the production-only placeholder publish guard and makes
#      supabase/seed.sql refuse to run there.
#
# Requires SUPABASE_GUARD_DB_URL (a postgres:// URL for the `deploy_guard` role).
set -euo pipefail

: "${SUPABASE_GUARD_DB_URL:?SUPABASE_GUARD_DB_URL is required}"
q() { psql "$SUPABASE_GUARD_DB_URL" -X -v ON_ERROR_STOP=1 -At -c "$1"; }

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
