import { describe, expect, it } from 'vitest';
import {
  firstName,
  greeting,
  partOfDay,
  siteHost,
  studioHour,
  subLine,
} from '@/lib/admin/dashboard/greeting';

// The dashboard's greeting (Admin v2 U1, ui.md §4 "Head"): the hour on the studio's clock
// (Asia/Riyadh, +03:00 all year), whatever the server's zone; the first word of the person's
// name, else the e-mail's local part.

const at = (iso: string) => new Date(iso);

describe('the part of the day is Riyadh’s', () => {
  it.each([
    ['2026-10-16T20:59:59Z', 23, 'evening'],
    ['2026-10-16T21:00:00Z', 0, 'morning'],
    ['2026-10-16T08:59:59Z', 11, 'morning'],
    ['2026-10-16T09:00:00Z', 12, 'afternoon'],
    ['2026-10-16T13:59:59Z', 16, 'afternoon'],
    ['2026-10-16T14:00:00Z', 17, 'evening'],
  ] as const)('%s is %i:xx in Riyadh: %s', (iso, hour, part) => {
    expect(studioHour(at(iso))).toBe(hour);
    expect(partOfDay(at(iso))).toBe(part);
  });
});

describe('the name', () => {
  it('the first word of the display name', () => {
    expect(firstName('Amal Al-Harbi', 'a@example.test')).toBe('Amal');
    expect(firstName('  أمل  الحربي ', 'a@example.test')).toBe('أمل');
  });

  it('else the e-mail’s local part', () => {
    expect(firstName(null, 'sam.lee@example.test')).toBe('sam.lee');
    expect(firstName('   ', 'sam@example.test')).toBe('sam');
    expect(firstName(undefined, '@example.test')).toBe('there');
  });

  it('greets in one line', () => {
    expect(greeting(at('2026-10-16T05:00:00Z'), 'Amal Al-Harbi', 'a@example.test')).toBe(
      'Good morning, Amal',
    );
  });
});

describe('the sub-line names the site’s host', () => {
  it('from PUBLIC_SITE_URL', () => {
    expect(siteHost('https://www.example.sa/')).toBe('www.example.sa');
    expect(siteHost('http://localhost:8788')).toBe('localhost:8788');
    expect(siteHost('not a url')).toBe('not a url');
    expect(subLine('https://example.sa')).toBe('Here is how example.sa is doing.');
  });
});
