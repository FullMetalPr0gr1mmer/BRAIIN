/*
 * The release-mode rehearsal's switch, as data (Admin v2 R14-prep): the two statements
 * tests/admin/releases.setup.ts sends as the owner, and the guard on where it may send them.
 * Pure, so tests/ci/releasesRehearsal.spec.ts holds them to migration 0112's function and to
 * the launch runbook's §6p call.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** True only for a postgres URL whose host is this machine (the e2e job's local stack). */
export function isLoopbackDbUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return false;
  return LOOPBACK.has(url.hostname.replace(/^\[|\]$/g, ''));
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
