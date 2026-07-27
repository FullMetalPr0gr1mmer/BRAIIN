import type { AnalyticsEvent } from '@schemas/analytics';
import type { WebVital } from '@schemas/webvitals';
import { resolveLaunchTenantId } from './tenant';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';

// Sinks for the three first-party telemetry streams: analytics events, web vitals, and
// search queries.
//
// All three share the same shape and the same two rules:
//
//   • the tenant is resolved SERVER-SIDE (`resolveLaunchTenantId` — the anon fence),
//     never taken from the request. These are unauthenticated writes; a client-chosen
//     tenant would be a cross-tenant write primitive in a tenant-ready schema.
//   • they NEVER throw. Telemetry that can break the page it is measuring is worse than
//     no telemetry — a beacon failure must not turn a working page view into a 500.
//
// Consent is checked by the CALLER, at the endpoint boundary, before anything reaches
// here. It is not re-checked in this module on purpose: one gate, in one place
// (`hasConsent`), is the CLAUDE.md §7 rule, and a second check here would invite the
// two to drift.

export async function recordAnalyticsEvent(event: AnalyticsEvent): Promise<boolean> {
  if (!supabaseConfigured()) return false;
  try {
    const tenantId = await resolveLaunchTenantId();
    if (!tenantId) return false;
    const { error } = await serviceClient()
      .from('analytics_events')
      .insert({
        tenant_id: tenantId,
        event_type: event.type,
        path: event.path ?? null,
        locale: event.locale,
        session_id: event.sessionId ?? null,
        props: event.props ?? {},
      });
    return !error;
  } catch {
    return false;
  }
}

export async function recordWebVital(vital: WebVital): Promise<boolean> {
  if (!supabaseConfigured()) return false;
  try {
    const tenantId = await resolveLaunchTenantId();
    if (!tenantId) return false;
    const { error } = await serviceClient()
      .from('web_vitals')
      .insert({
        tenant_id: tenantId,
        metric: vital.metric,
        value: vital.value,
        rating: vital.rating ?? null,
        path: vital.path ?? null,
      });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Logs a search so the SEO role's zero-result report has data.
 *
 * Deliberately NOT consent-gated, and deliberately storing no session id: what is
 * recorded is the query string and how many results it returned — a property of the
 * CONTENT, not of the person. Nothing here can be tied back to a visitor, which is why
 * it is lawful to keep without consent and why it carries no identifier to purge.
 */
export async function recordSearchQuery(
  q: string,
  locale: string,
  resultsCount: number,
): Promise<boolean> {
  if (!supabaseConfigured()) return false;
  try {
    const tenantId = await resolveLaunchTenantId();
    if (!tenantId) return false;
    const { error } = await serviceClient()
      .from('search_queries')
      .insert({
        tenant_id: tenantId,
        // Already capped at 64 chars and control-char-free by SearchQuerySchema; the
        // slice is belt-and-braces for any future caller that skips the schema.
        q: q.slice(0, 200),
        locale,
        results_count: resultsCount,
      });
    return !error;
  } catch {
    return false;
  }
}
