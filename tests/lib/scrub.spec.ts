import { describe, it, expect } from 'vitest';
import { scrubPii } from '@/lib/log/scrub';

// Privacy control (PDPL): client-reported log lines must never persist a visitor's
// email/phone. These assertions are the gate of record for that promise.
describe('scrubPii (operational-log PII scrubbing)', () => {
  it('redacts email addresses, including plus-tags and multi-part TLDs', () => {
    expect(scrubPii('failed for a.b+tag@example.co.uk')).toBe('failed for [email]');
    expect(scrubPii('x@y.io and z@w.com')).toBe('[email] and [email]');
  });

  it('redacts phone-like number runs (incl. international + separators)', () => {
    expect(scrubPii('call +966 50 123 4567 now')).toBe('call [phone] now');
    expect(scrubPii('tel (555) 010-9999')).toBe('tel [phone]');
  });

  it('leaves ordinary text and short numbers untouched', () => {
    expect(scrubPii('TypeError: cannot read x of undefined')).toBe(
      'TypeError: cannot read x of undefined',
    );
    expect(scrubPii('failed after 3 retries')).toBe('failed after 3 retries');
  });

  it('redacts PII embedded in a path/query string', () => {
    expect(scrubPii('/contact?email=jane@doe.com')).toBe('/contact?email=[email]');
  });
});
