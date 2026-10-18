import type { Monitor, ResponsePoint, UptimeDay } from '@schemas/healthProbe';

// The uptime monitor seam's shapes (Admin v2 G2): what any provider's adapter returns. The
// seam itself, and the deployment's configuration, are in ./index.ts.

export interface UptimeIncident {
  id: string;
  start: string;
  durationSec: number;
  reason: string;
}

/** What the monitor reports, normalised: the site's figures over its monitors. */
export interface UptimeReading {
  /** The lowest 30- and 90-day uptime over the monitors that are not paused (percent). */
  ratio30: number | null;
  ratio90: number | null;
  /** The last 90 Riyadh days, oldest first (the lowest ratio over the monitors). */
  days: UptimeDay[];
  /** Outages in the last 90 days, newest first, at most 10. */
  incidents: UptimeIncident[];
  /** The first monitor's hourly averages over 48 hours, oldest first. */
  responseTimes: ResponsePoint[];
  monitors: Monitor[];
  /** The TLS certificate's expiry, when the monitor reports one (D3). */
  certificate: { expires: string; issuer: string | null } | null;
  /** When the current outage began, while a monitor reads down. */
  downSince: string | null;
}

export interface UptimeProvider {
  readonly name: string;
  read(now: Date): Promise<UptimeReading>;
}

/** A provider's own failure that is not a transport one (the API said no, or made no sense). */
export class UptimeProviderError extends Error {
  constructor(readonly reason: 'api' | 'shape' | 'config') {
    super(`uptime provider ${reason}`);
    this.name = 'UptimeProviderError';
  }
}
