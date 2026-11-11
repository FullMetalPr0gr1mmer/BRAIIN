// A task as a calendar file (Admin v2 C8, crm.md §9 "GET /[id]/ics"): one VEVENT, written on the
// server, pure (no clock, no database, no environment: the route hands everything in, so the
// tests pin every byte).
//
// What it carries is the task's title and a link back to the admin, nothing else (data
// minimisation, crm.md "Deviations"): never the contact's name, the lead, the note or the
// owner. The file leaves the admin for someone's calendar, which may sync anywhere.
//
// RFC 5545: CRLF line ends; TEXT values escape backslash, semicolon, comma and line breaks
// (§3.3.11); a content line longer than 75 octets is folded with CRLF and one space (§3.1),
// never inside a UTF-8 character; times in UTC with the Z form (§3.3.5).

export interface IcsTask {
  id: string;
  title: string;
  /** The due moment, an ISO instant. */
  dueAt: string;
}

export interface IcsContext {
  /** The site's host (PUBLIC_SITE_URL's), for the UID: `<task id>@<host>`. */
  host: string;
  /** The brand (site_profile.brand_name.en), for the PRODID. Data, never hard-coded. */
  brand: string;
  /** The admin link written as the description. */
  link: string;
  /** When the file is made (DTSTAMP). */
  now: Date;
}

/** A TEXT value, escaped (RFC 5545 §3.3.11); any other control character dropped. */
export function escapeText(value: string): string {
  return (
    value
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n')
  );
}

const encoder = new TextEncoder();

/** One content line folded at 75 octets, never inside a character (RFC 5545 §3.1). */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  // A continuation line starts with a space, which counts toward its 75 octets.
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > limit) {
      parts.push(current);
      current = ' ';
      octets = 1;
      limit = 75;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n');
}

/** An instant in the UTC "basic" form, 20261110T070000Z. */
export function icsUtc(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** The calendar file for one task: 30 minutes from its due moment. */
export function buildTaskIcs(task: IcsTask, ctx: IcsContext): string {
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) throw new Error('ics: the due moment is not an instant');
  const brand = escapeText(ctx.brand.trim() || 'Admin').replace(/\/\//g, '/');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${brand}//Admin//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${task.id}@${ctx.host}`,
    `DTSTAMP:${icsUtc(ctx.now)}`,
    `DTSTART:${icsUtc(due)}`,
    'DURATION:PT30M',
    `SUMMARY:${escapeText(task.title)}`,
    `DESCRIPTION:${escapeText(ctx.link)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/**
 * The download's file name: an ASCII slug of the title, at most 60 characters, or `task.ics`
 * when nothing ASCII is left (an Arabic title). Quotes and path characters never survive.
 */
export function icsFilename(title: string): string {
  // No Unicode folding (the admin never transforms Arabic text, P-12): anything not ASCII
  // letters or digits becomes a hyphen.
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `${slug || 'task'}.ics`;
}
