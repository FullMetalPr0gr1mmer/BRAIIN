import { z } from 'zod';

// The dashboard (Admin v2 U1, docs/admin-v2/ui.md §4 "Dashboard", AV-09): a person's layout
// and quick actions (admin_user_prefs, 0044), the owner's presets per role
// (admin_role_defaults, 0060) and the shared team notes (team_notes, 0060). This package
// imports nothing from src/: the widget registry (src/lib/admin/dashboard/widgets.ts) and the
// quick-action library (src/lib/admin/quickActions.ts) are held to the lists here by tests.

// ── Widgets and layouts ──────────────────────────────────────────────────────────────

/** Every widget this build knows (later slices append theirs: publish, pipeline, tasks). */
export const WIDGET_IDS = [
  'kpis',
  'quick',
  'views',
  'leads',
  'attention',
  'health',
  'activity',
  'applications',
  'pages',
  'disciplines',
  'notes',
  // Website stats v2 (G1b): people on the site now and their pages, from the minute rollup.
  'realtime',
  // Release UX II (R13): the live version, unpublished changes and what is scheduled; drawn
  // only while releases are on (the dashboard drops it from the board otherwise).
  'publish',
] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

/** The board's three columns, in reading order. */
export const DASH_COLUMNS = ['top', 'left', 'right'] as const;
export type DashColumn = (typeof DASH_COLUMNS)[number];

export const isWidgetId = (value: unknown): value is WidgetId =>
  typeof value === 'string' && (WIDGET_IDS as readonly string[]).includes(value);

const widgetList = z.array(z.enum(WIDGET_IDS)).max(16);

/** A layout as it is stored and resolved: every column, and the widgets kept off the board. */
export interface DashboardLayout {
  top: WidgetId[];
  left: WidgetId[];
  right: WidgetId[];
  hidden: WidgetId[];
  /** The person (or the preset) chose quick actions, an empty list included (README U1 D8). */
  quickSet?: boolean;
}

/** No widget twice across the four lists. */
function eachOnce(layout: {
  [K in DashColumn | 'hidden']?: readonly string[] | undefined;
}): boolean {
  const ids = [...DASH_COLUMNS, 'hidden' as const].flatMap((key) => layout[key] ?? []);
  return new Set(ids).size === ids.length;
}

/** A whole layout (a preset's, or a person's after Customize): each widget at most once. */
export const DashboardLayoutSchema = z
  .object({
    top: widgetList,
    left: widgetList,
    right: widgetList,
    hidden: widgetList,
    quickSet: z.boolean().optional(),
  })
  .strict()
  .refine(eachOnce, { message: 'A widget can be on the dashboard only once.' });

/**
 * What a person's `dashboard` preference may hold: a whole layout, or no columns at all (the
 * role's preset, or the code's default, applies: "Reset"), with or without the quick-actions
 * flag. Never some columns without the others.
 */
export const DashboardPrefSchema = z
  .object({
    top: widgetList.optional(),
    left: widgetList.optional(),
    right: widgetList.optional(),
    hidden: widgetList.optional(),
    quickSet: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => {
      const present = [...DASH_COLUMNS, 'hidden' as const].filter((k) => value[k] !== undefined);
      return present.length === 0 || present.length === 4;
    },
    { message: 'A layout names every column, or none.' },
  )
  .refine(eachOnce, { message: 'A widget can be on the dashboard only once.' });
export type DashboardPref = z.infer<typeof DashboardPrefSchema>;

/** True when a stored layout names its columns (else the next source applies). */
export function hasColumns(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return DASH_COLUMNS.some((key) => Array.isArray((raw as Record<string, unknown>)[key]));
}

/**
 * A stored layout, read leniently (ui.md §10: "Dashboard prefs that reference removed widgets
 * are dropped silently"): an id this build does not know, or one already seen, is dropped;
 * a column that is not a list reads as empty; anything malformed reads as the empty layout.
 */
export function readDashboardLayout(raw: unknown): DashboardLayout {
  const out: DashboardLayout = { top: [], left: [], right: [], hidden: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;
  const seen = new Set<WidgetId>();
  for (const key of [...DASH_COLUMNS, 'hidden' as const]) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    for (const id of list) {
      if (isWidgetId(id) && !seen.has(id)) {
        seen.add(id);
        out[key].push(id);
      }
    }
  }
  if (record['quickSet'] === true) out.quickSet = true;
  return out;
}

// ── Quick actions ────────────────────────────────────────────────────────────────────

/**
 * The icons a person may give their own link: a closed list, each a symbol of the admin
 * sprite (tests/lib/quickActions.spec.ts holds it to src/lib/admin/icons.ts).
 */
export const QUICK_ICONS = [
  'link',
  'ext',
  'star',
  'zap',
  'cal',
  'mail',
  'globe',
  'note',
  'film',
  'chart',
  'users',
  'layers',
  'image',
] as const;
export type QuickIcon = (typeof QUICK_ICONS)[number];

/** A library action's id (src/lib/admin/quickActions.ts), as the presets' CHECK has it. */
export const QUICK_LIBRARY_ID = /^[a-z][a-z0-9-]{1,40}$/;
/** A person's own link's id: `c-` and a random tail, never a library id. */
export const QUICK_CUSTOM_ID = /^c-[a-z0-9]{8,32}$/;

export const QUICK_MAX = 12;
export const QUICK_CUSTOM_MAX = 8;
export const QUICK_LABEL_MAX = 40;
export const QUICK_HREF_MAX = 300;

// Any Unicode control or format character: a label shows on a colleague's screen only if
// they share the account, but it still must not reorder the text around it (adminPrefs'
// DISPLAY_NAME_REFUSED, the same class).
const LABEL_REFUSED = /[\p{Cc}\p{Cf}]/u;

/** An admin path: `/admin` or `/admin/…`, path characters only, an optional query. */
const ADMIN_PATH =
  /^\/admin(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*\/?(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/;

/**
 * A segment a browser reads as `.` or `..`: the WHATWG URL parser takes `%2e`, in either
 * case, as a dot there, so `/admin/%2e%2e/x` opens `/x`.
 */
function isDotSegment(segment: string): boolean {
  const decoded = segment.replace(/%2e/giu, '.');
  return decoded === '.' || decoded === '..';
}

/**
 * Where a person's own link may lead: an admin screen (`/admin…`) or an outside https
 * address. Refused: any other scheme (`javascript:` in any case, `data:`, `http:`), a
 * protocol-relative `//host` or `/\host`, a `.` or `..` segment (percent-encoded too:
 * `%2e%2e`, `.%2E`), a backslash, a username or
 * password, a host without a dot, more than 300 characters.
 */
export function isAdminOrHttpsHref(value: string): boolean {
  if (value.length === 0 || value.length > QUICK_HREF_MAX) return false;
  if (/[\\\s\p{Cc}\p{Cf}]/u.test(value)) return false;
  if (value.startsWith('/')) {
    if (value.startsWith('//')) return false;
    if (!ADMIN_PATH.test(value)) return false;
    const path = value.split('?')[0] ?? '';
    return !path.split('/').some(isDotSegment);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    /^https:\/\//i.test(value) &&
    url.username === '' &&
    url.password === '' &&
    url.hostname.includes('.') &&
    !url.hostname.startsWith('.') &&
    !url.hostname.endsWith('.')
  );
}

export const AdminOrHttpsHref = z
  .string()
  .trim()
  .refine(isAdminOrHttpsHref, 'Use an admin path starting with /admin, or an https:// address.');

export const QuickLibraryItemSchema = z.object({ id: z.string().regex(QUICK_LIBRARY_ID) }).strict();
export type QuickLibraryItem = z.infer<typeof QuickLibraryItemSchema>;

export const QuickCustomItemSchema = z
  .object({
    id: z.string().regex(QUICK_CUSTOM_ID),
    label: z
      .string()
      .trim()
      .min(1, 'Give it a label.')
      .max(QUICK_LABEL_MAX, `Use ${QUICK_LABEL_MAX} characters or fewer.`)
      .refine((value) => !LABEL_REFUSED.test(value), 'Use letters, numbers and spaces only.'),
    href: AdminOrHttpsHref,
    icon: z.enum(QUICK_ICONS),
  })
  .strict();
export type QuickCustomItem = z.infer<typeof QuickCustomItemSchema>;

export type QuickItem = QuickLibraryItem | QuickCustomItem;

export const isCustomItem = (item: QuickItem): item is QuickCustomItem => 'href' in item;

/** A person's quick actions: at most 12, at most 8 of them their own links, each id once. */
export const QuickActionsSchema = z
  .array(z.union([QuickCustomItemSchema, QuickLibraryItemSchema]))
  .max(QUICK_MAX, `Keep ${QUICK_MAX} quick actions or fewer.`)
  .refine(
    (items) => items.filter((item) => 'href' in item).length <= QUICK_CUSTOM_MAX,
    `Keep ${QUICK_CUSTOM_MAX} of your own links or fewer.`,
  )
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    'Each quick action can be on the list once.',
  );

/** Stored quick actions, read leniently: an element that does not parse is dropped. */
export function readQuickActions(raw: unknown): QuickItem[] {
  if (!Array.isArray(raw)) return [];
  const out: QuickItem[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const custom = QuickCustomItemSchema.safeParse(value);
    const item = custom.success ? custom.data : QuickLibraryItemSchema.safeParse(value).data;
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length === QUICK_MAX) break;
  }
  return out;
}

// ── The owner's presets ──────────────────────────────────────────────────────────────

/**
 * PUT /api/admin/dashboard/defaults/[role]: a role's layout, its quick actions (library ids
 * only, README U1 D3: a preset never carries a link), or both. `version` is the stored row's,
 * 0 when the role has none yet.
 */
export const RoleDefaultsPutSchema = z
  .object({
    version: z.number().int().min(0),
    dashboard: DashboardLayoutSchema.optional(),
    quickActions: z
      .array(QuickLibraryItemSchema)
      .max(QUICK_MAX)
      .refine((items) => new Set(items.map((i) => i.id)).size === items.length, 'Each once.')
      .optional(),
  })
  .strict()
  .refine((value) => value.dashboard !== undefined || value.quickActions !== undefined, {
    message: 'Send a layout, quick actions, or both.',
  });
export type RoleDefaultsPut = z.infer<typeof RoleDefaultsPutSchema>;

// ── Team notes ───────────────────────────────────────────────────────────────────────

export const TEAM_NOTES_MAX = 2000;
/** Days after the last edit when the note is cleared (app.expire_team_notes, 0060). */
export const TEAM_NOTES_RETENTION_DAYS = 180;

/**
 * The rule app.team_note_problem() applies in the database (0060), written the same way:
 * tests/lib/teamNotes.spec.ts runs both over one table of inputs (the pgTAP file's).
 *   - a C0 or C1 control character other than tab and line feed, or a format character (Cf);
 *   - something shaped like an e-mail address;
 *   - 8 or more digits (Western, Arabic-Indic U+0660-0669, Extended U+06F0-06F9), each
 *     followed by at most two of space, dot, hyphen and brackets: a phone number as it is
 *     usually written (055 123 4567, 055-123-4567, 055.123.4567, (055) 123-4567). A date
 *     with those separators is refused too (2026-10-14); one written with slashes is not.
 */
export const TEAM_NOTE_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]|\p{Cf}/u;
export const TEAM_NOTE_EMAIL = /[^ \t\n\v\f\r@]+@[^ \t\n\v\f\r@]+\.[^ \t\n\v\f\r@]+/u;
export const TEAM_NOTE_PHONE = /([0-9\u0660-\u0669\u06F0-\u06F9][ .()-]{0,2}){8,}/u;

export type TeamNoteProblem = 'team_notes_chars' | 'team_notes_contact' | 'team_notes_length';

/**
 * The most a save may send before it is trimmed: twice the limit, in UTF-16 units (2,000
 * astral characters are 4,000 of them). Checked before anything else reads the text, by the
 * Worker and by the definer, so a body of any size costs one length test, never a scan.
 */
export const TEAM_NOTES_RAW_MAX = TEAM_NOTES_MAX * 2;

/** Space, tab, line feed, vertical tab, form feed, carriage return. */
const TRIMMED: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

/**
 * What the definer trims first: trailing spaces, tabs and line breaks. A walk back from the
 * end, linear: `/[…]+$/` retries from every position of a long run, which is quadratic.
 */
export function trimNote(value: string): string {
  let end = value.length;
  while (end > 0 && TRIMMED.has(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

/**
 * Whether the text holds something TEAM_NOTE_EMAIL matches, found by a linear scan. The regex
 * stays the statement of the rule (the database runs that text; tests/lib/teamNotes.spec.ts
 * holds this scan to it), but in JavaScript it backtracks along one long unbroken token
 * (2,000 letters cost about 4 ms, nearly half the Free plan's 10 ms CPU). A match is X@Y.Z
 * inside one whitespace-delimited token, X, Y and Z non-empty and free of `@`: so two
 * neighbouring `@`-parts of a token, the first non-empty, the second with a dot that is
 * neither its first nor its last character.
 */
export function hasEmailShape(value: string): boolean {
  if (!value.includes('@')) return false;
  for (const token of value.split(/[ \t\n\v\f\r]/u)) {
    if (!token.includes('@')) continue;
    const parts = token.split('@');
    for (let i = 0; i + 1 < parts.length; i += 1) {
      const local = parts[i] ?? '';
      const domain = parts[i + 1] ?? '';
      const dot = domain.indexOf('.', 1);
      if (local.length > 0 && dot !== -1 && dot < domain.length - 1) return true;
    }
  }
  return false;
}

/** Why a note is refused, as the database says it, or null. Counts code points, as it does. */
export function teamNoteProblem(value: string): TeamNoteProblem | null {
  if ([...value].length > TEAM_NOTES_MAX) return 'team_notes_length';
  if (TEAM_NOTE_CONTROL.test(value)) return 'team_notes_chars';
  if (hasEmailShape(value) || TEAM_NOTE_PHONE.test(value)) return 'team_notes_contact';
  return null;
}

/** The sentence each refusal shows under the field. */
export const TEAM_NOTE_MESSAGES: Readonly<Record<TeamNoteProblem, string>> = {
  team_notes_length: `Keep the note to ${TEAM_NOTES_MAX.toLocaleString('en-GB')} characters.`,
  team_notes_chars: 'Remove the hidden control or formatting characters.',
  team_notes_contact:
    'Remove e-mail addresses and phone numbers (any run of 8 or more digits). Keep client details in leads.',
};

/**
 * The note as a save sends it (the SingletonForm's PATCH, so `version` is the row's: 0 before
 * the first save). Trimmed as the definer trims; refused as it refuses.
 */
export const TeamNotesPutSchema = z
  .object({
    version: z.number().int().min(0),
    body: z
      .string()
      .max(TEAM_NOTES_RAW_MAX, TEAM_NOTE_MESSAGES.team_notes_length)
      .transform(trimNote)
      .superRefine((value, ctx) => {
        const problem = teamNoteProblem(value);
        if (problem)
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: TEAM_NOTE_MESSAGES[problem] });
      }),
  })
  .strict();
export type TeamNotesPut = z.infer<typeof TeamNotesPutSchema>;
