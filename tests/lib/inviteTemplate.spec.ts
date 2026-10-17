import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INVITE_PAGE, inviteTokenFrom } from '@/lib/auth/inviteToken';
import { INVITE_LINK_LIFETIME } from '@/lib/admin/userModel';

// The invite e-mail (Admin v2 U12b): the local stack's template (supabase/templates/
// invite.html, wired in supabase/config.toml) and what the code expects of it. The hosted
// projects paste the same link (launch runbook §2b), so this also pins the runbook's line.

const CONFIG = readFileSync('supabase/config.toml', 'utf8');
const TEMPLATE = readFileSync('supabase/templates/invite.html', 'utf8');
const RUNBOOK = readFileSync('docs/launch-runbook.md', 'utf8');
const INVITE_API = readFileSync('src/pages/api/admin/users/index.ts', 'utf8');

const LINK = '{{ .SiteURL }}/admin/invite?token_hash={{ .TokenHash }}&type=invite';

describe('the invite e-mail', () => {
  it('the local stack sends the template in this repo', () => {
    const section = /\[auth\.email\.template\.invite\]([\s\S]*?)(?:\n\[|$)/.exec(CONFIG)?.[1];
    expect(section).toBeDefined();
    expect(section).toMatch(/content_path = "\.\/supabase\/templates\/invite\.html"/);
    expect(section).toMatch(/subject = "[^"]+"/);
  });

  it('its link opens the invite page with the token hash, never a session in a fragment', () => {
    expect(TEMPLATE).toContain(`href="${LINK}"`);
    expect(TEMPLATE).not.toMatch(/\{\{\s*\.ConfirmationURL\s*\}\}/);
    expect(TEMPLATE).not.toMatch(/\{\{\s*\.Token\s*\}\}/);
    // The page reads exactly that shape.
    const token = 'a1b2c3d4'.repeat(7);
    const url = new URL(
      LINK.replace('{{ .SiteURL }}', 'https://example.com').replace('{{ .TokenHash }}', token),
    );
    expect(url.pathname).toBe(INVITE_PAGE);
    expect(inviteTokenFrom(url.searchParams, undefined)).toBe(token);
  });

  it('the message is the key the invite writes, and only when there is one', () => {
    expect(INVITE_API).toContain('{ invite_message: message }');
    expect(TEMPLATE).toContain('{{ if .Data.invite_message }}');
    expect(TEMPLATE).toContain('{{ .Data.invite_message }}');
    // Go's html/template escapes an action's output; nothing marks it safe.
    expect(TEMPLATE).not.toMatch(/\|\s*(safeHTML|html)\b/);
  });

  it('says one hour, as the screen does and the expiry is (decision D1)', () => {
    expect(CONFIG).toMatch(/^otp_expiry = 3600$/m);
    expect(TEMPLATE).toContain('The link works for one hour.');
    expect(INVITE_LINK_LIFETIME).toContain('The link works for one hour.');
  });

  it('the runbook gives the hosted projects the same link', () => {
    expect(RUNBOOK).toContain(LINK);
    expect(RUNBOOK).toContain('<origin>/admin/invite');
  });
});
