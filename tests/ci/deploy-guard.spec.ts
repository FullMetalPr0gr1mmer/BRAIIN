import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * scripts/deploy-guard.sh — what stops ci.yml's `deploy` from shipping code whose migrations
 * production lacks (launch runbook §5a) — and the root CA it pins.
 *
 * The CA checks run on every platform. The script itself runs on Linux (CI's build-test job;
 * skipped on Windows) against a stub `psql` first on PATH. The stub refuses to "connect"
 * unless the guard pinned verify-full TLS (GSSAPI encryption off), the committed root CA and
 * the connect timeout, with no other PG* variable left in its environment, and answers the
 * guard's four queries from STUB_* variables — so every refusal path is driven without a
 * database, and none of them may print the password the URL carries.
 */

const CA = 'scripts/certs/supabase-root-2021-ca.crt';
// openssl x509 -noout -fingerprint -sha256 -in scripts/certs/supabase-root-2021-ca.crt
const ROOT_SHA256 =
  '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';

describe('the Supabase root CA the deploy guard pins', () => {
  const ca = new X509Certificate(readFileSync(CA));

  it('is the root whose fingerprint launch runbook §5a records', () => {
    expect(ca.fingerprint256).toBe(ROOT_SHA256);
  });

  it('is the self-signed Supabase Root 2021 CA', () => {
    expect(ca.subject.split('\n')).toContain('CN=Supabase Root 2021 CA');
    expect(ca.ca).toBe(true);
    expect(ca.issuer).toBe(ca.subject);
    expect(ca.verify(ca.publicKey)).toBe(true);
  });

  // The root expires 2031-04-26, and from then on every deploy fails closed at the guard.
  // This goes red 90 days ahead: commit Supabase's next root first (runbook §5a).
  it('stays valid for at least 90 more days', () => {
    const daysLeft = (ca.validToDate.getTime() - Date.now()) / 86_400_000;
    expect(daysLeft).toBeGreaterThanOrEqual(90);
  });
});

const SCRIPT = resolve('scripts/deploy-guard.sh');
const PASSWORD = 'pw-never-printed-7f3c91';
const GUARD_URL = `postgresql://deploy_guard.xkxthzcmmvtnwicerlup:${PASSWORD}@aws-1-eu-west-2.pooler.supabase.com:5432/postgres`;

// The psql stand-in. It never echoes its arguments: the first one is the URL, password and all.
const STUB_PSQL = String.raw`#!/usr/bin/env bash
if [[ "$PGSSLMODE" != verify-full || "$PGGSSENCMODE" != disable || "$PGCONNECT_TIMEOUT" != 10 ]] ||
  [[ "$PGSSLROOTCERT" != */scripts/certs/supabase-root-2021-ca.crt || ! -s "$PGSSLROOTCERT" ]]; then
  echo 'psql: error: the stub refuses: TLS or the connect timeout is not pinned' >&2
  exit 2
fi
stray="$(compgen -e | grep '^PG' | grep -vxE 'PGSSLMODE|PGSSLROOTCERT|PGGSSENCMODE|PGCONNECT_TIMEOUT|PGAPPNAME')"
if [[ -n "$stray" ]]; then
  echo "psql: error: the stub refuses: $stray reached psql" >&2
  exit 2
fi
if [[ -n "$STUB_DOWN" ]]; then
  echo 'psql: error: connection to server failed: SSL error: certificate verify failed' >&2
  exit 2
fi
for sql; do :; done
case "$sql" in
  'select current_user') echo "$STUB_USER" ;;
  'select version from supabase_migrations.schema_migrations order by version') printf '%s\n' $STUB_APPLIED ;;
  "select to_regclass('app.deployment') is not null") echo "$STUB_REGCLASS" ;;
  *'from app.deployment'*) echo "$STUB_ENV" ;;
  *) echo 'psql: error: the stub does not know this query' >&2; exit 3 ;;
esac
`;

// Production as it should be: the guard role, both fixture migrations applied, the marker set.
const PRODUCTION = {
  SUPABASE_GUARD_DB_URL: GUARD_URL,
  STUB_USER: 'deploy_guard',
  STUB_APPLIED: '0001 0016',
  STUB_REGCLASS: 't',
  STUB_ENV: 'production',
};

describe.skipIf(process.platform === 'win32')('scripts/deploy-guard.sh', () => {
  let dir = '';
  let bin = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-guard-'));
    mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true });
    for (const file of ['0001_a.sql', '0016_page_sections_public.sql']) {
      writeFileSync(join(dir, 'supabase', 'migrations', file), '-- fixture\n');
    }
    bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'psql'), STUB_PSQL, { mode: 0o755 });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs the guard from the fixture repo; nothing the guard reads is inherited. */
  function guard(env: Record<string, string>): { status: number | null; out: string } {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !/^(PG|SUPABASE_|STUB_|PATH$)/i.test(entry[0]),
      ),
    );
    const childEnv: Record<string, string> = {
      ...inherited,
      PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
      ...PRODUCTION,
      ...env,
    };
    // worker-configuration.d.ts types ProcessEnv as the Worker's env (its keys required); a
    // child process environment is just strings.
    const run = spawnSync('bash', [SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: childEnv as NodeJS.ProcessEnv,
    });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  }

  it('passes with its three ✓ lines when production has every migration', () => {
    const { status, out } = guard({});
    expect(status, out).toBe(0);
    expect(out).toContain(
      '✓ connected as deploy_guard (TLS verified against the Supabase root CA).',
    );
    expect(out).toContain('✓ production has every migration in the repo (2 applied).');
    expect(out).toContain('✓ app.deployment = production.');
    expect(out).not.toContain('::error::');
    expect(out).not.toContain(PASSWORD);
  });

  it('pins TLS itself: no PG* variable from its environment reaches psql', () => {
    // The stub refuses any PG* variable but the five the guard pins. PGSERVICE above all: it
    // names a service file, whose settings (sslmode=disable, another root) beat the pins.
    const { status, out } = guard({
      PGSSLMODE: 'disable',
      PGSSLROOTCERT: '/nonexistent.crt',
      PGCONNECT_TIMEOUT: '0',
      PGGSSENCMODE: 'prefer',
      PGSERVICE: 'impostor',
      PGSERVICEFILE: '/tmp/pg_service.conf',
      PGSYSCONFDIR: '/tmp',
      PGHOSTADDR: '203.0.113.7',
      PGSSLMINPROTOCOLVERSION: 'TLSv1',
    });
    expect(status, out).toBe(0);
  });

  const refusals: [string, Record<string, string>, RegExp][] = [
    ['an empty URL', { SUPABASE_GUARD_DB_URL: '' }, /SUPABASE_GUARD_DB_URL is empty/],
    [
      'a URL with a query string (it would override the pinned TLS)',
      { SUPABASE_GUARD_DB_URL: `${GUARD_URL}?sslmode=require` },
      /must have no query string/,
    ],
    [
      'a key=value connection string (same reason)',
      {
        SUPABASE_GUARD_DB_URL: `host=aws-1-eu-west-2.pooler.supabase.com sslmode=disable password=${PASSWORD}`,
      },
      /must be a postgresql:\/\/ URL/,
    ],
    [
      'a connection psql cannot make or verify',
      { STUB_DOWN: '1' },
      /cannot connect to production as the guard role/,
    ],
    ['a privileged role', { STUB_USER: 'postgres' }, /connected as 'postgres', not deploy_guard/],
    [
      'a migration production lacks',
      { STUB_APPLIED: '0001' },
      /missing 1 migration\(s\): 0016_page_sections_public\.sql/,
    ],
    ['a database that is not production', { STUB_ENV: 'staging' }, /app\.deployment is 'staging'/],
    [
      'an app.deployment marker it cannot read',
      { STUB_REGCLASS: 'f' },
      /app\.deployment is not readable/,
    ],
  ];

  for (const [what, env, message] of refusals) {
    it(`fails closed on ${what}`, () => {
      const { status, out } = guard(env);
      expect(status, out).toBe(1);
      expect(out).toMatch(/::error::/);
      expect(out).toMatch(message);
      expect(out).not.toContain('✓ app.deployment = production.');
      expect(out).not.toContain(PASSWORD);
    });
  }
});
