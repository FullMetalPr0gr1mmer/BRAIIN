/*
 * The release-mode rehearsal's switch, as data (Admin v2 R14-prep): the two statements
 * tests/admin/releases.setup.ts sends as the owner, and the guard on where it may send them.
 * Pure, so tests/ci/releasesRehearsal.spec.ts holds them to migration 0112's function and to
 * the launch runbook's §6p call.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
/** A user or database name psql cannot read as anything else (no `=`, no URI, no space). */
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;

/**
 * True only for a postgres URL whose host is this machine (the e2e job's local stack). A query
 * string or a fragment is refused outright: libpq reads `?host=`, `?hostaddr=` and `?service=`
 * as connection keywords that replace the URL's own host (R14-prep review S3).
 */
export function isLoopbackDbUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return false;
  if (url.search !== '' || url.hash !== '' || raw.includes('?') || raw.includes('#')) return false;
  return LOOPBACK.has(url.hostname.replace(/^\[|\]$/g, ''));
}

/**
 * Where psql connects, built from the parsed URL instead of handing psql the URL itself: the
 * loopback address as both `host` and `hostaddr` (so no service file or environment can point
 * it elsewhere), the port, a plain user and database name, and the password for PGPASSWORD.
 * Null for anything isLoopbackDbUrl refuses or a name psql could read as a connection string.
 */
export function loopbackPsqlTarget(raw: string): { conninfo: string; password: string } | null {
  if (!isLoopbackDbUrl(raw)) return null;
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addr = host === 'localhost' ? '127.0.0.1' : host;
  const port = url.port || '5432';
  let user: string;
  let db: string;
  let password: string;
  try {
    user = decodeURIComponent(url.username) || 'postgres';
    db = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres';
    password = decodeURIComponent(url.password);
  } catch {
    return null;
  }
  if (!/^[0-9]{1,5}$/.test(port) || !PLAIN_NAME.test(user) || !PLAIN_NAME.test(db)) return null;
  return {
    conninfo: `host=${addr} hostaddr=${addr} port=${port} user=${user} dbname=${db}`,
    password,
  };
}

/** The environment psql runs with: the password, and no libpq variable that could redirect it. */
export function psqlEnv<E extends Readonly<Record<string, string | undefined>>>(
  base: E,
  password: string,
): E {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) if (!key.startsWith('PG')) env[key] = value;
  env['PGPASSWORD'] = password;
  // The same keys as the base (the process's typed environment), less the PG ones.
  return env as E;
}

/**
 * Whether releases are on, and the switch itself: the runbook's call with the operator as its
 * own fallback scheduler (the rehearsal's one Admin). Ids only, checked, never interpolated
 * from anywhere else.
 */
export function RELEASES_SWITCH_SQL(
  tenant: string,
  operator: string,
): { isOn: string; enable: string } {
  if (!UUID.test(tenant) || !UUID.test(operator)) throw new Error('the switch takes two uuids');
  return {
    isOn: `select app.releases_enabled('${tenant}'::uuid)`,
    enable: `select app.enable_releases('${tenant}'::uuid, '${operator}'::uuid, '${operator}'::uuid)`,
  };
}
