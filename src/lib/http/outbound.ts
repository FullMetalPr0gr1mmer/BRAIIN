// Outbound JSON requests to third parties (Admin v2 G2: the uptime monitor's API, the IANA
// RDAP bootstrap, a registry's RDAP server; R7's cache purge should reuse it). CLAUDE.md
// Pillar 4: a third-party call has a timeout, backoff with jitter, a breaker and idempotent
// retries. This module is the per-call half; the breaker is the caller's persisted backoff
// (src/lib/health/probes.ts keeps it in the probe's row, so it survives isolates).
//
//   timeout      every request is aborted after `timeoutMs` (5 s), its body included;
//   size cap     the body is read through a counting reader and refused past `maxBytes`
//                (256 KB), before it is parsed, so a hostile or broken server cannot make
//                the Worker buffer megabytes (a Free-plan isolate has 128 MB and 10 ms CPU);
//   one retry    on a network error or a 5xx only, after 200 to 600 ms of jitter. Never on a
//                4xx (the request is wrong and will stay wrong) or a timeout (a server that
//                is slow now is slow in half a second too, and the cron tries again in 10
//                minutes);
//   redirects    `redirect: 'manual'`: a GET follows at most one hop, to https, with no
//                credentials in the URL, carrying only its Accept header. A POST never
//                follows one: its body (the monitor's key) must not be replayed to an
//                address we did not choose;
//   budget       retries and redirect hops share one budget of `retries + 1` requests, so a
//                call costs at most 2 subrequests (the Free plan allows 50 per invocation;
//                src/lib/cron/health.ts adds them up).
//
// It never sends a cookie, a session or any header the caller did not name, and an error
// carries a status and a reason code only: never the URL's query, the request body, a key
// or the response body (an error page can echo what it was sent).

export type OutboundReason =
  'bad-url' | 'timeout' | 'network' | 'http' | 'redirect' | 'too-large' | 'not-json';

export class OutboundError extends Error {
  constructor(
    readonly reason: OutboundReason,
    readonly status: number | null = null,
  ) {
    super(status === null ? `outbound ${reason}` : `outbound ${reason} ${status}`);
    this.name = 'OutboundError';
  }
}

export interface OutboundInit {
  method?: 'GET' | 'POST';
  /** The headers sent, and nothing else. */
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

export interface OutboundOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Retries after the first request (network errors and 5xx only). */
  retries?: number;
  /** Seams for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface OutboundResult {
  status: number;
  json: unknown;
}

export const OUTBOUND_DEFAULTS = { timeoutMs: 5_000, maxBytes: 262_144, retries: 1 } as const;
/** The jitter before a retry, in milliseconds. */
export const RETRY_JITTER_MS = { min: 200, max: 600 } as const;

/** The URL, when it is one this module will call: https, no user or password. */
export function safeUrl(raw: string, base?: string): URL | null {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  return url;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reads a body to at most `maxBytes`, or throws `too-large`. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new OutboundError('too-large', response.status);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new OutboundError('too-large', response.status);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Drops a body nobody reads, so the connection is released. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * One JSON request, under the rules above. Resolves with a 2xx's status and parsed body;
 * throws OutboundError for anything else (`http` with the status for a non-2xx, so a caller
 * can read a 404 as "not found").
 */
export async function outboundJson(
  rawUrl: string,
  init: OutboundInit = {},
  options: OutboundOptions = {},
): Promise<OutboundResult> {
  const {
    timeoutMs = OUTBOUND_DEFAULTS.timeoutMs,
    maxBytes = OUTBOUND_DEFAULTS.maxBytes,
    retries = OUTBOUND_DEFAULTS.retries,
    fetchImpl = fetch,
    sleep = wait,
    random = Math.random,
  } = options;
  const method = init.method ?? 'GET';
  const first = safeUrl(rawUrl);
  if (!first) throw new OutboundError('bad-url');

  let budget = retries + 1;
  let retriesLeft = retries;
  let url = first;
  let hopped = false;
  let headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body = init.body;

  for (;;) {
    budget -= 1;
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      if (timedOut) throw new OutboundError('timeout');
      if (retriesLeft > 0 && budget > 0) {
        retriesLeft -= 1;
        await sleep(jitter(random));
        continue;
      }
      throw new OutboundError('network');
    }

    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      const next = safeUrl(response.headers.get('location') ?? '', url.toString());
      if (method !== 'GET' || hopped || budget <= 0 || !next) {
        throw new OutboundError('redirect', response.status);
      }
      hopped = true;
      url = next;
      // A hop carries nothing but what says the answer should be JSON.
      headers = headers['accept'] ? { accept: headers['accept'] } : {};
      body = undefined;
      continue;
    }
    if (response.status >= 500) {
      await discard(response);
      if (retriesLeft > 0 && budget > 0) {
        retriesLeft -= 1;
        await sleep(jitter(random));
        continue;
      }
      throw new OutboundError('http', response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      await discard(response);
      throw new OutboundError('http', response.status);
    }

    let text: string;
    try {
      text = await readCapped(response, maxBytes);
    } catch (err) {
      if (err instanceof OutboundError) throw err;
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new OutboundError(timedOut ? 'timeout' : 'network', response.status);
    }
    try {
      return { status: response.status, json: JSON.parse(text) as unknown };
    } catch {
      throw new OutboundError('not-json', response.status);
    }
  }
}

function jitter(random: () => number): number {
  return Math.round(RETRY_JITTER_MS.min + random() * (RETRY_JITTER_MS.max - RETRY_JITTER_MS.min));
}
