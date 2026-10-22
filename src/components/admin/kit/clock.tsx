import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { DEFAULT_TIME_ZONE } from '@schemas/timeZones';
import { clockFor, type Clock } from '@/lib/admin/relTime';

// The studio's clock inside an island (Admin v2 U9). The zone is the server's: an island that
// prints a date in its server HTML (the leads screens, which arrive with their rows) takes it
// as a `tz` prop from its page (`await studioTimeZone(Astro.locals)`) and wraps itself in
// <ClockProvider>, so the server render and the hydrated render print the same string.
//
// An island that prints dates only after it has loaded or saved something in the browser (a
// list fetched on mount, "Saved at 14:05") may go without a provider: useClock() then reads
// the zone AdminLayout wrote on the page (`<html data-studio-tz>`, the same server value).
// Its server render prints no date, so there is nothing to mismatch. On the server, with no
// provider, it is the default zone, which such an island never prints.

const ClockContext = createContext<Clock | null>(null);

/** The zone AdminLayout wrote on the page, in a browser; the default on the server. */
export function pageTimeZone(): string {
  if (typeof document === 'undefined') return DEFAULT_TIME_ZONE;
  return document.documentElement.dataset['studioTz'] ?? DEFAULT_TIME_ZONE;
}

export function ClockProvider({ tz, children }: { tz?: string | undefined; children: ReactNode }) {
  const clock = useMemo(() => clockFor(tz ?? pageTimeZone()), [tz]);
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
}

/** The studio's clock: the provider's, else the page's zone (see above). */
export function useClock(): Clock {
  return useContext(ClockContext) ?? clockFor(pageTimeZone());
}
