import { describe, it, expect } from 'vitest';
import { buildTaskIcs, escapeText, foldLine, icsFilename, icsUtc } from '@/lib/crm/ics';

// A task's calendar file (Admin v2 C8, crm.md §9 and §13 "crmIcs"): RFC 5545 escaping and
// 75-octet folding, UTC times, the UID's host and the PRODID's brand from data, and nothing
// about the person: the title and the admin link only.

const TASK = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Call Huda; bring samples, quote\\notes',
  dueAt: '2026-11-11T07:00:00.000Z',
};
const CTX = {
  host: 'www.example.test',
  brand: 'Studio, Ltd',
  link: 'https://www.example.test/admin/tasks#task-11111111-1111-4111-8111-111111111111',
  now: new Date('2026-11-10T12:34:56.789Z'),
};
const octets = (line: string) => new TextEncoder().encode(line).length;

describe('the calendar file', () => {
  const ics = buildTaskIcs(TASK, CTX);
  const lines = ics.split('\r\n');

  it('is CRLF throughout, one VEVENT, ending with a line break', () => {
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
  });

  it('takes the UID host and the PRODID brand from data', () => {
    expect(lines).toContain(`UID:${TASK.id}@www.example.test`);
    expect(lines).toContain('PRODID:-//Studio\\, Ltd//Admin//EN');
  });

  it('writes its times in UTC, half an hour from the due moment', () => {
    expect(lines).toContain('DTSTART:20261111T070000Z');
    expect(lines).toContain('DTSTAMP:20261110T123456Z');
    expect(lines).toContain('DURATION:PT30M');
  });

  it('escapes the title (backslash, semicolon, comma) and carries the admin link only', () => {
    expect(lines).toContain('SUMMARY:Call Huda\\; bring samples\\, quote\\\\notes');
    expect(ics).toContain('DESCRIPTION:https://www.example.test/admin/tasks#task-');
    // Nothing else: no attendee, organizer, location, note or contact.
    expect(ics).not.toMatch(/ATTENDEE|ORGANIZER|LOCATION|CONTACT|COMMENT/);
  });

  it('carries only what it is handed: never a note, a contact or a lead', () => {
    const own = buildTaskIcs(
      { ...TASK, ...({ note: 'secret note', contact: 'Sara', lead: 'Lead #4' } as object) },
      CTX,
    );
    expect(own).not.toMatch(/secret note|Sara|Lead #4/);
  });

  it('refuses a due moment that is not one', () => {
    expect(() => buildTaskIcs({ ...TASK, dueAt: 'tomorrow' }, CTX)).toThrow();
  });
});

describe('RFC 5545 text', () => {
  it('escapes line breaks and drops other control characters', () => {
    expect(escapeText('a\r\nb\nc\u0007d')).toBe('a\\nb\\ncd');
  });

  it('folds at 75 octets, a continuation starting with a space, never inside a character', () => {
    const long = `SUMMARY:${'م'.repeat(80)}`; // two octets each
    const folded = foldLine(long).split('\r\n');
    expect(folded.length).toBeGreaterThan(1);
    for (const line of folded) expect(octets(line)).toBeLessThanOrEqual(75);
    for (const line of folded.slice(1)) expect(line.startsWith(' ')).toBe(true);
    expect(folded.map((l, i) => (i === 0 ? l : l.slice(1))).join('')).toBe(long);
    // No replacement character: no character was cut.
    expect(folded.join('')).not.toContain('�');
  });

  it('leaves a short line alone', () => {
    expect(foldLine('VERSION:2.0')).toBe('VERSION:2.0');
  });

  it('writes the basic UTC form', () => {
    expect(icsUtc(new Date('2026-01-02T03:04:05.006Z'))).toBe('20260102T030405Z');
  });
});

describe('the file name', () => {
  it('is an ASCII slug of the title, at most 60 characters before .ics', () => {
    expect(icsFilename('Call Huda: "the logo" / v2')).toBe('call-huda-the-logo-v2.ics');
    expect(icsFilename('x'.repeat(100))).toBe(`${'x'.repeat(60)}.ics`);
    // No folding: an accented letter is not ASCII, so it becomes a hyphen.
    expect(icsFilename('Café crème')).toBe('caf-cr-me.ics');
  });

  it('is task.ics when nothing ASCII is left', () => {
    expect(icsFilename('اتصل بهدى')).toBe('task.ics');
  });
});
