import { PAGE_ACCESS_LABEL, labelledKeyMaterial } from '@/lib/applications/keys';
import { hmacHex } from '@/lib/crypto/hmac';

// The proof that a visitor typed a page's password (Admin v2 U14b).
//
// The unlock route checks the password in the database (public.page_password_check, the
// service role, behind a limiter that fails closed) and then mints this cookie; the
// middleware verifies it on every later request for that page. Nothing about the password
// is in it: the cookie says "this browser answered page X at version N, until T", signed so
// the browser cannot write one itself.
//
//   name   __Host-braiin-pa-<the page's id, hex, no dashes>
//   value  base64url("v1|<page id>|<pv>|<expiry, seconds>") . HMAC-SHA256 of that text
//   key    labelledKeyMaterial(LEAD_PII_ENC_KEY, 'page-access/v1') — no new secret, the
//          src/lib/applications/keys.ts precedent; a labelled derivation, so this key can
//          stand in for none of the others.
//
// `__Host-` is the point of the name: a cookie with that prefix is accepted only with
// Secure and Path=/ and no Domain, so a sibling host (or a subdomain someone takes over)
// cannot write one for this origin. Path=/ is what the prefix demands, so the cookie is
// SENT on every request of this site; what scopes it to one page is its name and, because
// the page's id is signed into the payload, its signature: a cookie minted for one page
// verifies for no other.
//
// The version is the fence against a password that has been changed: `password_version`
// moves on every set_page_password and whenever a page leaves password mode (0061), the KV
// snapshot carries the current one, and a cookie naming an older one stops verifying within
// the snapshot's minute.
//
// Pure (no astro:env import): the caller passes the root key, so the Worker, the unlock
// route and the tests share one implementation.

/** How long one unlock lasts: 12 hours, as the design sets it. */
export const PAGE_ACCESS_MAX_AGE_SECONDS = 12 * 60 * 60;

const PREFIX = '__Host-braiin-pa-';
const VERSION = 'v1';

/** The cookie that proves this browser unlocked `pageId`. */
export function pageAccessCookieName(pageId: string): string {
  return `${PREFIX}${pageId.replace(/-/g, '').toLowerCase()}`;
}

/** The cookie attributes, as `Set-Cookie` needs them (`__Host-`: Secure, Path=/, no Domain). */
export const PAGE_ACCESS_COOKIE_ATTRS = `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${PAGE_ACCESS_MAX_AGE_SECONDS}`;

export interface PageAccessClaim {
  pageId: string;
  pv: number;
}

const enc = new TextEncoder();

/** base64url of a UTF-8 string, without padding. */
function toBase64Url(value: string): string {
  let binary = '';
  for (const byte of enc.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** The signed text: version, page, password version, expiry. */
function payloadOf(claim: PageAccessClaim, expiresAt: number): string {
  return `${VERSION}|${claim.pageId}|${claim.pv}|${expiresAt}`;
}

function keyOf(rootKey: string): string {
  return labelledKeyMaterial(rootKey, PAGE_ACCESS_LABEL);
}

/**
 * Compares two hex digests without leaking where they differ. Both are hex of a fixed
 * length, so the length check tells an attacker nothing the format did not.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The cookie's value for a page just unlocked. */
export async function mintAccessCookie(
  rootKey: string,
  claim: PageAccessClaim,
  now: number = Date.now(),
): Promise<string> {
  const expiresAt = Math.floor(now / 1000) + PAGE_ACCESS_MAX_AGE_SECONDS;
  const payload = payloadOf(claim, expiresAt);
  return `${toBase64Url(payload)}.${await hmacHex(keyOf(rootKey), payload)}`;
}

/**
 * Whether this cookie proves THIS page at THIS password version, and has not expired.
 * Anything else — no cookie, a tampered one, one for another page, one minted before the
 * password changed, one past its expiry — is false, with no distinction made between them.
 */
export async function verifyAccessCookie(
  rootKey: string,
  cookie: string | null | undefined,
  claim: PageAccessClaim,
  now: number = Date.now(),
): Promise<boolean> {
  if (typeof cookie !== 'string' || cookie.length === 0 || cookie.length > 512) return false;
  const dot = cookie.indexOf('.');
  if (dot <= 0 || dot === cookie.length - 1) return false;
  const encoded = cookie.slice(0, dot);
  const signature = cookie.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const payload = fromBase64Url(encoded);
  if (payload === null) return false;
  if (!timingSafeEqualHex(signature, await hmacHex(keyOf(rootKey), payload))) return false;
  // Only now is the payload trusted enough to read.
  const parts = payload.split('|');
  if (parts.length !== 4 || parts[0] !== VERSION) return false;
  if (parts[1] !== claim.pageId) return false;
  if (parts[2] !== String(claim.pv)) return false;
  const expiresAt = Number(parts[3]);
  return Number.isSafeInteger(expiresAt) && Math.floor(now / 1000) < expiresAt;
}

/** The `Set-Cookie` header value for a page just unlocked. */
export async function pageAccessSetCookie(
  rootKey: string,
  claim: PageAccessClaim,
  now: number = Date.now(),
): Promise<string> {
  const value = await mintAccessCookie(rootKey, claim, now);
  return `${pageAccessCookieName(claim.pageId)}=${value}; ${PAGE_ACCESS_COOKIE_ATTRS}`;
}
