#!/usr/bin/env bash
# Launch runbook §5a — create (or rotate) the read-only `deploy_guard` role that
# scripts/deploy-guard.sh connects as, and set the SUPABASE_GUARD_DB_URL repository secret.
# The password never appears in any command, file or output: it lives in a shell variable and
# in the pipe to `gh`, which encrypts it client-side; Postgres receives only a SCRAM-SHA-256
# verifier. Re-running rotates it.
#
# Run from the root of a checkout linked to production (`npx supabase@2.119.0 link
# --project-ref xkxthzcmmvtnwicerlup`), logged in to the Supabase CLI (`npx supabase@2.119.0
# login`; no token in any command) and with the repository owner's GitHub credential stored
# for git (Git Credential Manager), which the script reads for its `gh` calls only.
# tests/ci/deploy-guard-role.spec.ts drives it against stub tools.
#
# Order matters (reviews of 2026-10-05). Everything that can fail without writing runs
# first: the CLI login, the GitHub identity, the linked project, and a read-only preflight
# of production (every migration in this checkout applied — the guard's own rule — and
# app.deployment = 'production'), which also exercises the CLI and the parser once. Then the
# one production write (the role), then a read-back of the role's attributes and grants, and
# only then the GitHub secret. A failure between the write and the secret leaves production
# with a password no secret holds (a first run: the old state, no secret; a rotation: deploys
# fail closed at the guard) — re-run the script, it rotates.
set -euo pipefail
umask 077
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
unset SUPABASE_ACCESS_TOKEN GH_TOKEN
ref=xkxthzcmmvtnwicerlup
host=aws-1-eu-west-2.pooler.supabase.com
repo=FullMetalPr0gr1mmer/BRAIIN
owner=FullMetalPr0gr1mmer
# The project is pinned by --project-ref (never whatever this checkout happens to be linked
# to); --agent yes fixes the JSON shape ({rows: [...]}) whoever runs the script; the update
# notifier is off, and stdout (the JSON, nothing else) is kept apart from stderr ('Initialising
# login role...', notices), so the parse never sees anything but the JSON.
sb() { SUPABASE_NO_UPDATE_NOTIFIER=1 npx --yes supabase@2.119.0 "$@"; }
sbq() { sb db query --linked --project-ref "$ref" --agent yes -o json -f "$1"; }
# First row of a query's JSON (either CLI shape), as JSON, on stdout.
row() {
  node -e '
const s = require("node:fs").readFileSync(process.argv[1], "utf8");
const j = JSON.parse(s.slice(s.search(/[[{]/)));
const rows = Array.isArray(j) ? j : j.rows;
if (!rows || !rows[0]) { console.error("no rows in " + process.argv[1]); process.exit(1); }
process.stdout.write(JSON.stringify(rows[0]));' "$1"
}

# 1. Preconditions — nothing below this block writes unless all of them hold.
sb projects list -o json >/dev/null 2>&1 || { echo "Supabase CLI not logged in" >&2; exit 1; }
[ "$(cat supabase/.temp/project-ref 2>/dev/null || true)" = "$ref" ] ||
  { echo "this checkout is not linked to $ref (supabase/.temp/project-ref)" >&2; exit 1; }
# The owner's GitHub token, unexported: only the `gh` calls below ever see it.
tok="$(printf 'protocol=https\nhost=github.com\nusername=%s\n\n' "$owner" | git credential fill 2>/dev/null | sed -n 's/^password=//p')" || tok=""
[ -n "$tok" ] || { echo "no stored GitHub credential for $owner" >&2; exit 1; }
[ "$(GH_TOKEN="$tok" gh api user --jq .login)" = "$owner" ] || { echo "wrong GitHub account" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"; unset pw verifier url tok' EXIT INT TERM

# 2. Read-only preflight of production.
cat > "$work/preflight.sql" <<'SQL'
select json_build_object(
  'versions', (select coalesce(json_agg(version order by version), '[]'::json) from supabase_migrations.schema_migrations),
  'env', (select env from app.deployment)
) as preflight;
SQL
echo "== preflight"
sbq "$work/preflight.sql" >"$work/preflight.json" 2>"$work/preflight.err" ||
  { cat "$work/preflight.err" >&2; exit 1; }
ls supabase/migrations/*.sql | sed 's|.*/||; s|_.*||' > "$work/local.txt"
row "$work/preflight.json" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const p = JSON.parse(s).preflight;
  const applied = new Set((p.versions || []).map(String));
  const local = require("node:fs").readFileSync(process.argv[1], "utf8").split(/\s+/).filter(Boolean);
  const missing = local.filter((v) => !applied.has(v));
  const bad = [];
  if (!local.length) bad.push("no migrations in this checkout");
  if (missing.length) bad.push("production lacks " + missing.join(", ") + ": apply it first (launch runbook section 1: db push from a clean checkout of main), then re-run");
  if (p.env !== "production") bad.push("app.deployment = " + JSON.stringify(p.env));
  if (bad.length) { console.error("refusing before any write: " + bad.join("; ")); process.exit(1); }
  console.log(`production: every one of ${local.length} local migrations applied (${applied.size} recorded), env=production`);
});' "$work/local.txt"

# 3. The password and its verifier.
pw="$(openssl rand -hex 24)"
verifier="$(printf '%s' "$pw" | node -e '
const c = require("node:crypto");
let p = "";
process.stdin.on("data", (d) => (p += d)).on("end", () => {
  const salt = c.randomBytes(16), iters = 4096;
  const key = c.pbkdf2Sync(p, salt, iters, 32, "sha256");
  const hmac = (k, m) => c.createHmac("sha256", k).update(m).digest();
  const stored = c.createHash("sha256").update(hmac(key, "Client Key")).digest("base64");
  const server = hmac(key, "Server Key").toString("base64");
  process.stdout.write(`SCRAM-SHA-256$${iters}:${salt.toString("base64")}$${stored}:${server}`);
});')"
[[ "$verifier" =~ ^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$ ]] || { echo "bad verifier" >&2; exit 1; }

# 4. The role — the one production write.
cat > "$work/role.tpl" <<'SQL'
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'deploy_guard') then
    alter role deploy_guard with login connection limit 5 password '__V__';
  else
    create role deploy_guard with login nosuperuser nocreatedb nocreaterole noinherit connection limit 5 password '__V__';
  end if;
end $g$;
alter role deploy_guard set default_transaction_read_only = on;
alter role deploy_guard set statement_timeout = '15s';
grant usage on schema supabase_migrations to deploy_guard;
grant select on supabase_migrations.schema_migrations to deploy_guard;
grant usage on schema app to deploy_guard;
grant select on app.deployment to deploy_guard;
SQL
sed "s|__V__|${verifier}|g" "$work/role.tpl" > "$work/role.sql"
echo "== role"
rc=0
sbq "$work/role.sql" >"$work/role.out" 2>"$work/role.err" || rc=$?
# Shown redacted (the CLI may echo the statement on an error).
cat "$work/role.out" "$work/role.err" |
  V="$verifier" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s.split(process.env.V).join("<redacted>")+"\n"))'
[ "$rc" = 0 ] || { echo "role SQL failed (exit $rc)" >&2; exit 1; }

# 5. Read the role back; check every attribute and grant BEFORE the secret is written.
cat > "$work/verify.sql" <<'SQL'
select json_build_object(
  'canlogin', r.rolcanlogin, 'super', r.rolsuper, 'inherit', r.rolinherit,
  'createrole', r.rolcreaterole, 'createdb', r.rolcreatedb, 'replication', r.rolreplication,
  'bypassrls', r.rolbypassrls, 'connlimit', r.rolconnlimit, 'config', r.rolconfig,
  'member_of', (select count(*) from pg_auth_members m where m.member = r.oid),
  'mig_usage', has_schema_privilege(r.oid, 'supabase_migrations', 'usage'),
  'mig_select', has_table_privilege(r.oid, 'supabase_migrations.schema_migrations', 'select'),
  'app_usage', has_schema_privilege(r.oid, 'app', 'usage'),
  'dep_select', has_table_privilege(r.oid, 'app.deployment', 'select'),
  'dep_write', has_table_privilege(r.oid, 'app.deployment', 'insert,update,delete,truncate'),
  'leads_select', has_table_privilege(r.oid, 'public.leads', 'select')
) as guard_role
from pg_roles r where r.rolname = 'deploy_guard';
SQL
echo "== verify"
sbq "$work/verify.sql" >"$work/verify.json" 2>"$work/verify.err" ||
  { cat "$work/verify.err" >&2; exit 1; }
row "$work/verify.json" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const g = JSON.parse(s).guard_role;
  if (!g) { console.error("no guard_role"); process.exit(1); }
  console.log(JSON.stringify(g));
  const want = { canlogin: true, super: false, inherit: false, createrole: false, createdb: false,
    replication: false, bypassrls: false, connlimit: 5, member_of: 0, mig_usage: true,
    mig_select: true, app_usage: true, dep_select: true, dep_write: false, leads_select: false };
  const bad = Object.entries(want).filter(([k, v]) => g[k] !== v).map(([k, v]) => `${k}=${JSON.stringify(g[k])} (want ${JSON.stringify(v)})`);
  const cfg = g.config || [];
  for (const c of ["default_transaction_read_only=on", "statement_timeout=15s"]) if (!cfg.includes(c)) bad.push(`config lacks ${c}`);
  if (bad.length) { console.error("refusing to set the secret:\n  " + bad.join("\n  ")); process.exit(1); }
  console.log("role checked: login, read-only, unprivileged, no memberships, exactly the four grants");
});'

# 6. The secret — the GitHub write, last.
url="postgresql://deploy_guard.${ref}:${pw}@${host}:5432/postgres"
printf '%s' "$url" | GH_TOKEN="$tok" gh secret set SUPABASE_GUARD_DB_URL --repo "$repo"
echo "== secrets"
GH_TOKEN="$tok" gh secret list --repo "$repo"
