// Stub for `astro:env/server` under vitest. See astro-env-client.ts.
// These are NON-FUNCTIONAL placeholders: a test that somehow reached a real Supabase or
// crypto path with these would fail loudly rather than quietly succeed against something
// real. Never put a working secret here.

export const SUPABASE_SERVICE_ROLE_KEY = 'test-dummy-service-role-key';
export const SUPABASE_DB_POOL_URL = 'postgresql://test:test@localhost:6543/test';
export const LEAD_PII_ENC_KEY = 'test-dummy-lead-pii-enc-key';
export const AUDIT_HMAC_KEY = 'test-dummy-audit-hmac-key';
export const NOTIFY_LEAD_SECRET = 'test-dummy-notify-lead-secret';
// Off, as a project without SMTP ships (owner item O-2). Tests of the "set up" path mock
// src/lib/auth/recovery.ts's authEmailReady() instead of editing this.
export const AUTH_EMAIL_READY = false;
// Off, as every production build ships until the owner signs off the notice (Admin v2 U15).
// Tests of the switched-on path mock src/lib/http/ga4.ts's ga4NoticeReady() instead.
export const GA4_NOTICE_READY = false;
// Not set up, as a deployment without an uptime monitor ships (owner item O-20). Tests of the
// "set up" path pass a config to src/lib/health/uptime's uptimeProvider() instead.
export const UPTIME_MONITOR_API_KEY: string | undefined = undefined;
export const UPTIME_MONITOR_IDS: string | undefined = undefined;
// Not set up, as a deployment without a cache zone ships (owner item O-3). Tests of the "set up"
// path pass a config to src/lib/http/purge.ts's purgeTags() instead.
export const CF_ZONE_ID: string | undefined = undefined;
export const CF_CACHE_PURGE_TOKEN: string | undefined = undefined;
