import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Two factor sign in (Admin v2 U17) needs the auth server's authenticator apps (TOTP) on. The
// local stack (and so CI's e2e, tests/admin/twoStep.e2e.ts) pins them in supabase/config.toml,
// so a change of the CLI's defaults cannot switch them off unnoticed; the hosted projects set
// them in the dashboard (launch runbook §2, owner item O-25). While a project has them off,
// /admin/2fa says "Not set up" (src/lib/auth/twoStepFlow.ts) and nothing else changes.

/** One TOML table's own lines, comments dropped: from its header to the next one. */
function tomlTable(name: string): string {
  const lines = readFileSync(join(process.cwd(), 'supabase/config.toml'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (start < 0) return '';
  const next = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line));
  return lines
    .slice(start + 1, next < 0 ? undefined : next)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

describe('the local auth server offers authenticator apps (supabase/config.toml)', () => {
  it('enrols and verifies TOTP factors', () => {
    const totp = tomlTable('auth.mfa.totp');
    expect(totp).toMatch(/^enroll_enabled\s*=\s*true\s*$/m);
    expect(totp).toMatch(/^verify_enabled\s*=\s*true\s*$/m);
  });

  it('keeps GoTrue’s ceiling of factors per person', () => {
    expect(tomlTable('auth.mfa')).toMatch(/^max_enrolled_factors\s*=\s*10\s*$/m);
  });

  it('runs the access-token hook that withholds the role below the required level', () => {
    const hook = tomlTable('auth.hook.custom_access_token');
    expect(hook).toMatch(/^enabled\s*=\s*true\s*$/m);
    expect(hook).toMatch(/custom_access_token_hook/);
  });
});
