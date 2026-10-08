import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/*
 * scripts/deploy-guard-role.sh — creates or rotates the `deploy_guard` role and sets the
 * SUPABASE_GUARD_DB_URL secret (launch runbook §5a). It writes to production and to GitHub, so
 * it runs here against stub `npx`, `git` and `gh` first on PATH, from a fixture checkout. The
 * stubs refuse unless the script pins what the review of 2026-10-05 found unpinned — the
 * project (--project-ref), the CLI's JSON shape (--agent yes), the update notifier
 * (SUPABASE_NO_UPDATE_NOTIFIER) — and unless the GitHub token stays away from the Supabase
 * CLI. Each case asserts the order of writes: nothing reaches production before every check
 * that can fail without writing, and the secret is set only after the role reads back right.
 * Linux only, like deploy-guard.spec.ts (CI's build-test job).
 */

const SCRIPT = resolve('scripts/deploy-guard-role.sh');
const REF = 'xkxthzcmmvtnwicerlup';
const TOKEN = 'gh-token-never-printed-5b1d';

const STUB_NPX = String.raw`#!/usr/bin/env bash
[[ -z "$GH_TOKEN" ]] || { echo 'stub npx: GH_TOKEN reached the Supabase CLI' >&2; exit 9; }
[[ "$1 $2" == '--yes supabase@2.119.0' ]] || { echo "stub npx: unexpected $1 $2" >&2; exit 9; }
shift 2
case "$1 $2" in
  'projects list') [[ -n "$STUB_NOLOGIN" ]] && exit 1; echo '[]'; exit 0 ;;
  'db query') ;;
  *) echo "stub npx: unexpected $*" >&2; exit 9 ;;
esac
[[ "$SUPABASE_NO_UPDATE_NOTIFIER" == 1 ]] || { echo 'stub npx: update notifier left on' >&2; exit 9; }
args=" $* "
for need in ' --linked ' " --project-ref ${REF} " ' --agent yes ' ' -o json '; do
  [[ "$args" == *"$need"* ]] || { echo "stub npx: missing$need" >&2; exit 9; }
done
file=''; prev=''
for a in "$@"; do [[ "$prev" == -f ]] && file="$a"; prev="$a"; done
name="$(basename "$file" .sql)"
echo "$name" >> "$STUB_LOG"
echo 'Initialising login role...' >&2
[[ "$STUB_FAIL" == "$name" ]] && { echo 'ERROR: simulated failure' >&2; exit 1; }
var="STUB_$(echo "$name" | tr a-z A-Z)"
body="${'$'}{!var}"
if [[ "$STUB_SHAPE" == bare ]]; then printf '[%s]\n' "$body"; else printf '{"boundary":"b","rows":[%s],"warning":"w"}\n' "$body"; fi
[[ -n "$STUB_NOTICE" ]] && printf 'A new version of Supabase CLI is available: v9.9.9 (currently installed v2.119.0)\n' >&2
exit 0
`;

const STUB_GIT = String.raw`#!/usr/bin/env bash
[[ "$1 $2" == 'credential fill' ]] || { echo "stub git: unexpected $*" >&2; exit 9; }
cat > /dev/null
[[ -n "$STUB_NOCRED" ]] && { echo 'fatal: could not read Password: terminal prompts disabled' >&2; exit 128; }
printf 'protocol=https\nhost=github.com\nusername=FullMetalPr0gr1mmer\npassword=%s\n' "$STUB_TOKEN"
`;

const STUB_GH = String.raw`#!/usr/bin/env bash
[[ "$GH_TOKEN" == "$STUB_TOKEN" ]] || { echo 'stub gh: not the owner token' >&2; exit 9; }
case "$1 $2" in
  'api user') echo "${'$'}{STUB_LOGIN:-FullMetalPr0gr1mmer}" ;;
  'secret set')
    url="$(cat)"
    [[ "$url" =~ ^postgresql://deploy_guard\.${REF}:[0-9a-f]{48}@aws-1-eu-west-2\.pooler\.supabase\.com:5432/postgres$ ]] ||
      { echo 'stub gh: not the guard URL shape' >&2; exit 9; }
    printf '%s' "${'$'}{url#*:*:}" > "$STUB_DIR/password-tail"
    echo secret-set >> "$STUB_LOG" ;;
  'secret list') echo 'SUPABASE_GUARD_DB_URL	now' ;;
  *) echo "stub gh: unexpected $*" >&2; exit 9 ;;
esac
`;

const ROLE = {
  canlogin: true,
  super: false,
  inherit: false,
  createrole: false,
  createdb: false,
  replication: false,
  bypassrls: false,
  connlimit: 5,
  config: ['default_transaction_read_only=on', 'statement_timeout=15s'],
  member_of: 0,
  mig_usage: true,
  mig_select: true,
  app_usage: true,
  dep_select: true,
  dep_write: false,
  leads_select: false,
};
const LOCAL = ['0001', '0016', '0030'];
const preflight = (versions: string[], env = 'production') =>
  JSON.stringify({ preflight: { versions, env } });
const role = (over: Partial<typeof ROLE> = {}) =>
  JSON.stringify({ guard_role: { ...ROLE, ...over } });

describe.skipIf(process.platform === 'win32')('scripts/deploy-guard-role.sh', () => {
  let dir = '';
  let bin = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-guard-role-'));
    mkdirSync(join(dir, 'supabase', '.temp'), { recursive: true });
    mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true });
    writeFileSync(join(dir, 'supabase', '.temp', 'project-ref'), `${REF}\n`);
    for (const v of LOCAL) writeFileSync(join(dir, 'supabase', 'migrations', `${v}_m.sql`), '--\n');
    bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npx'), STUB_NPX, { mode: 0o755 });
    writeFileSync(join(bin, 'git'), STUB_GIT, { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), STUB_GH, { mode: 0o755 });
    writeFileSync(join(dir, 'log'), '');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs the script from the fixture checkout; returns its exit, output and the writes made. */
  function run(env: Record<string, string>) {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !/^(SUPABASE_|STUB_|GH_|PATH$)/i.test(entry[0]),
      ),
    );
    writeFileSync(join(dir, 'log'), ''); // each run's writes, not the test's
    rmSync(join(dir, 'password-tail'), { force: true });
    const childEnv: Record<string, string> = {
      ...inherited,
      PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
      STUB_LOG: join(dir, 'log'),
      STUB_DIR: dir,
      STUB_TOKEN: TOKEN,
      STUB_PREFLIGHT: preflight(LOCAL),
      STUB_VERIFY: role(),
      ...env,
    };
    // worker-configuration.d.ts types ProcessEnv as the Worker's env (its keys required); a
    // child process environment is just strings (as in deploy-guard.spec.ts).
    const result = spawnSync('bash', [SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: childEnv as NodeJS.ProcessEnv,
    });
    const out = `${result.stdout}${result.stderr}`;
    const writes = readFileSync(join(dir, 'log'), 'utf8').split('\n').filter(Boolean);
    const tail = join(dir, 'password-tail');
    // The URL's password (with the @host tail): it must never reach the output.
    const password = existsSync(tail) ? readFileSync(tail, 'utf8').split('@')[0]! : '';
    expect(out, 'the GitHub token reached the output').not.toContain(TOKEN);
    expect(out, 'the SCRAM verifier reached the output').not.toMatch(/SCRAM-SHA-256\$4096:/);
    if (password) expect(out, 'the password reached the output').not.toContain(password);
    return { status: result.status, out, writes };
  }

  const FULL = ['preflight', 'role', 'verify', 'secret-set'];

  it('creates the role, reads it back, then sets the secret', () => {
    const { status, out, writes } = run({});
    expect(status, out).toBe(0);
    expect(writes).toEqual(FULL);
    expect(out).toContain('every one of 3 local migrations applied');
    expect(out).toContain('exactly the four grants');
  });

  it('accepts a production ahead of the checkout — the guard’s own rule', () => {
    const { status, out, writes } = run({ STUB_PREFLIGHT: preflight([...LOCAL, '0031']) });
    expect(status, out).toBe(0);
    expect(writes).toEqual(FULL);
  });

  it('parses either JSON shape, and ignores what the CLI writes to stderr', () => {
    expect(run({ STUB_SHAPE: 'bare' }).writes).toEqual(FULL);
    expect(run({ STUB_NOTICE: '1' }).writes).toEqual(FULL);
  });

  const beforeAnyWrite: [string, Record<string, string>, RegExp, string[]][] = [
    ['the CLI is not logged in', { STUB_NOLOGIN: '1' }, /not logged in/, []],
    ['no owner credential is stored', { STUB_NOCRED: '1' }, /no stored GitHub credential/, []],
    [
      'the credential is not the owner’s',
      { STUB_LOGIN: 'someone-else' },
      /wrong GitHub account/,
      [],
    ],
    [
      'production lacks a migration this checkout has',
      { STUB_PREFLIGHT: preflight(['0001', '0016']) },
      /production lacks 0030: apply it first/,
      ['preflight'],
    ],
    [
      'the marker is not production',
      { STUB_PREFLIGHT: preflight(LOCAL, 'staging') },
      /app\.deployment = "staging"/,
      ['preflight'],
    ],
  ];
  for (const [what, env, message, writes] of beforeAnyWrite) {
    it(`refuses before any write when ${what}`, () => {
      const run1 = run(env);
      expect(run1.status, run1.out).toBe(1);
      expect(run1.out).toMatch(message);
      expect(run1.writes).toEqual(writes);
    });
  }

  it('refuses when the checkout is linked to another project', () => {
    writeFileSync(join(dir, 'supabase', '.temp', 'project-ref'), 'otherprojectref00000\n');
    const { status, out, writes } = run({});
    expect(status, out).toBe(1);
    expect(out).toMatch(/not linked to xkxthzcmmvtnwicerlup/);
    expect(writes).toEqual([]);
  });

  it('sets no secret when the role reads back wrong', () => {
    const { status, out, writes } = run({
      STUB_VERIFY: role({ inherit: true, config: ['statement_timeout=15s'] }),
    });
    expect(status, out).toBe(1);
    expect(out).toMatch(/refusing to set the secret/);
    expect(out).toMatch(/inherit=true/);
    expect(out).toMatch(/config lacks default_transaction_read_only=on/);
    expect(writes).toEqual(['preflight', 'role', 'verify']);
  });

  it('sets no secret when the role SQL fails', () => {
    const { status, out, writes } = run({ STUB_FAIL: 'role' });
    expect(status, out).toBe(1);
    expect(out).toMatch(/role SQL failed/);
    expect(writes).toEqual(['preflight', 'role']);
  });
});
