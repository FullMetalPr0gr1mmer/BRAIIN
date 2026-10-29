import type { ActivityKind } from '@schemas/audit';
import { RELEASE_ENTITY_TYPES } from '@schemas/release';
import { RESOURCES } from '@/lib/admin/resources';
import { columnOf, RESOURCE_UI, SINGLETON_UI, type FieldDef } from '@/lib/admin/ui';
import type { BadgeTone } from '@/lib/admin/tones';
import { isRole } from '@/lib/auth/types';
import { ROLE_LABELS } from '@/lib/authz/capLabels';
import { hasTitleSource } from './auditTitles';

// The activity log in plain words (Admin v2 U13, docs/admin-v2/ui.md AV-22): one registry
// that says, for every action the admin writes to audit_log, what kind of activity it is
// (the chips), what the person did ("Revealed the contact details of"), to what ("a lead"),
// and whether the item's title may be shown beside it. The page, the JSON route and the CSV
// export all describe rows through describe(); kindFilter() gives the SQL filter of a chip,
// from the same entries, so a chip finds exactly the rows the badge names.
//
// What a row may show is decided here, not by the row: `detail` is metadata the writer
// chose, and a staff token may insert a row of its own (0002's audit_insert; 0050 binds only
// its actor, role and time), so nothing read from a row is trusted as markup or as a key.
// The page renders every part as a text node; the field names a save changed are shown,
// never their values; an action or a field name that is not a plain key is not shown at all.
//
// tests/lib/auditLabels.spec.ts holds the registry to the code: every action written in
// src/ and in the migrations has an entry, the kinds are disjoint, every resource has a noun.

/** A chip's kind, or `other`: an action no chip covers (job applications), shown under All. */
export type ActivityRowKind = ActivityKind | 'other';

export interface ActivityRow {
  id: number | string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: unknown;
  created_at: string;
}

export interface ActivityDescription {
  kind: ActivityRowKind;
  /** What the person did, sentence case: "Updated", "Revealed the contact details of". */
  verb: string;
  /** What it was done to ("the service", "a lead"), or null when the verb says it all. */
  noun: string | null;
  /** The item whose title may be shown (an allowlisted type, never a person or a lead). */
  titleRef: { type: string; id: string } | null;
  /** The names of the fields a save changed, in words; never what they hold. */
  fields: string[];
}

type Detail = Readonly<Record<string, unknown>>;

interface Label {
  kind: ActivityRowKind | ((detail: Detail) => ActivityRowKind);
  verb: string | ((detail: Detail) => string);
  noun: string | null | ((detail: Detail) => string | null);
  /** The touched item (`entity_type`, `entity_id`) may be titled. */
  titled?: boolean;
}

/** What each kind is called on a row's badge and on its chip, and the badge's tone. */
export const KIND_BADGE: Readonly<Record<ActivityRowKind, { label: string; tone: BadgeTone }>> = {
  edits: { label: 'Edit', tone: 'gray' },
  publishing: { label: 'Publish', tone: 'klein' },
  leads: { label: 'Lead', tone: 'ok' },
  users: { label: 'User', tone: 'sky' },
  settings: { label: 'Setting', tone: 'warn' },
  other: { label: 'Other', tone: 'dark' },
};

/** The chips, in the prototype's order (screens_ops.js, the activity log). */
export const KIND_CHIPS: readonly { kind: ActivityKind; label: string }[] = [
  { kind: 'edits', label: 'Edits' },
  { kind: 'publishing', label: 'Publishing' },
  { kind: 'leads', label: 'Leads' },
  { kind: 'users', label: 'Users' },
  { kind: 'settings', label: 'Settings' },
];

/** The statuses a save can move content to that make it a publish. */
export const PUBLISHING_STATUSES = ['published', 'scheduled'] as const;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** "ok" outcomes read as done, "partial" as partly done, anything else as not done. */
function outcome(done: string, notDone: string, partly?: string) {
  return (detail: Detail) => {
    const status = str(detail['status']);
    if (status === 'ok') return done;
    if (status === 'partial' && partly) return partly;
    return notDone;
  };
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

// ── The resource kernel's actions (src/lib/admin/resource.ts) ────────────────────────────

/** A save's kind: a publish when it moved the item to published or scheduled (U13 records
 *  the status a save moved to; older rows have none and read as edits). */
function savedKind(detail: Detail): ActivityRowKind {
  const status = str(detail['status']);
  return status && (PUBLISHING_STATUSES as readonly string[]).includes(status)
    ? 'publishing'
    : 'edits';
}

function createVerb(detail: Detail): string {
  const status = str(detail['status']);
  if (status === 'published') return 'Published';
  if (status === 'scheduled') return 'Scheduled';
  return 'Added';
}

function updateVerb(detail: Detail): string {
  const status = str(detail['status']);
  if (status === 'published') return 'Published';
  if (status === 'scheduled') return 'Scheduled';
  if (status === 'archived') return 'Archived';
  if (status === 'draft') {
    const before = str(detail['previousStatus']);
    if (before === 'archived') return 'Restored';
    if (before === 'published' || before === 'scheduled') return 'Unpublished';
  }
  return 'Updated';
}

interface EntityInfo {
  /** "the service". */
  noun: string;
  /** "Services": the list a reorder changed. */
  list: string;
  fields: readonly FieldDef[];
}

/** Every kernel entity (audit_log.entity_type) with its words, from its editor's config. */
export const KERNEL_ENTITIES: ReadonlyMap<string, EntityInfo> = new Map(
  Object.entries(RESOURCES).map(([slug, config]) => {
    const ui = RESOURCE_UI[slug];
    return [
      config.entity,
      {
        noun: `the ${lowerFirst(ui?.singular ?? config.entity.replaceAll('_', ' '))}`,
        list: ui?.title ?? config.entity,
        fields: ui?.fields ?? [],
      },
    ];
  }),
);

/**
 * The kernel's actions for one entity, as resource.ts writes them, and the staged branch's
 * (src/lib/release/staged.ts, Admin v2 R3) while releases are on: a pending change saved or
 * thrown away.
 */
export const KERNEL_VERBS = [
  'create',
  'update',
  'delete',
  'reorder',
  'draft_save',
  'draft_discard',
] as const;

/** A pending change saved: its op says what it will do once published. */
function draftSaveVerb(detail: Detail): string {
  const op = str(detail['op']);
  if (op === 'delete') return 'Saved an unpublished removal of';
  if (op === 'reorder') return 'Saved an unpublished new order for';
  return 'Saved unpublished changes to';
}

/** The per-tenant settings rows (src/lib/admin/singleton.ts) and their editors. */
const SINGLETONS: Readonly<Record<string, { noun: string; ui: string }>> = {
  site_settings: { noun: 'the general settings', ui: 'settings' },
  site_integrations: { noun: 'the integrations', ui: 'integrations' },
  seo_defaults: { noun: 'the global SEO defaults', ui: 'seo' },
  site_profile: { noun: 'the public identity', ui: 'profile' },
  ai_config: { noun: 'the Style-Finder results and logic', ui: 'ai-config' },
  // Admin v2 E5: edited by its own island (no SINGLETON_UI entry): its fields read as their
  // keys in plain words.
  site_appearance: { noun: 'the header', ui: 'appearance' },
};
export const SINGLETON_ENTITIES: readonly string[] = Object.keys(SINGLETONS);

/** The noun of an entity type named by a row (entity SEO names its target type). */
function nounOf(type: string | null): string | null {
  if (!type) return null;
  return KERNEL_ENTITIES.get(type)?.noun ?? null;
}

/** "the SEO role": a preset's role, from its detail (one of the four, else plainly "a role"). */
function roleNoun(detail: Detail): string {
  const role = detail['role'];
  return isRole(role) ? `the ${ROLE_LABELS[role]} role` : 'a role';
}

/** "version 15" from a release row's detail, else "a version". */
function versionNoun(detail: Detail): string {
  const n = detail['number'] ?? detail['version'];
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? `version ${n}` : 'a version';
}

// ── Every other action, by its exact key ──────────────────────────────────────────────────

const EXACT: Readonly<Record<string, Label>> = {
  // Edits that are not the kernel's
  'entity_seo.update': {
    kind: 'edits',
    verb: 'Updated the search details of',
    noun: (detail) => nounOf(str(detail['target'])) ?? 'an item',
  },
  'page.visibility': {
    kind: 'edits',
    verb: (detail) => (detail['navVisible'] === false ? 'Hid from the menu' : 'Showed in the menu'),
    noun: 'the page',
    titled: true,
  },
  'redirect.sync': { kind: 'edits', verb: 'Refreshed', noun: 'the live redirects' },
  'media_asset.upload': { kind: 'edits', verb: 'Uploaded', noun: 'the asset', titled: true },
  'media_asset.replace': {
    kind: 'edits',
    verb: 'Replaced the file of',
    noun: 'the asset',
    titled: true,
  },
  'media_asset.update_meta': {
    kind: 'edits',
    verb: 'Updated the details of',
    noun: 'the asset',
    titled: true,
  },

  // Website stats goals (G1c): immediate, not in RESOURCES, so their kernel actions are
  // named here. A goal's name is admin text; only the act is described.
  'analytics_goal.create': { kind: 'settings', verb: 'Added', noun: 'a website stats goal' },
  'analytics_goal.update': { kind: 'settings', verb: 'Updated', noun: 'a website stats goal' },
  'analytics_goal.delete': { kind: 'settings', verb: 'Deleted', noun: 'a website stats goal' },

  // The dashboard (U1): the shared note (its length only is recorded, never its words) and
  // the owner's presets per role.
  'dashboard.notes.update': { kind: 'edits', verb: 'Updated', noun: 'the team notes' },
  'dashboard.notes.expire': {
    kind: 'edits',
    verb: 'Cleared',
    noun: 'the team notes, 180 days after their last edit',
  },

  // Leads
  'lead.create': { kind: 'leads', verb: 'Added', noun: 'a lead' },
  'lead.create.duplicate': {
    kind: 'leads',
    verb: 'Found possible duplicates while adding',
    noun: 'a lead',
  },
  'lead.update': { kind: 'leads', verb: 'Updated', noun: 'a lead' },
  'lead.bulk': { kind: 'leads', verb: 'Changed several leads at once', noun: null },
  'lead.view': { kind: 'leads', verb: 'Opened', noun: 'a lead' },
  'lead.view_pii': { kind: 'leads', verb: 'Revealed the contact details of', noun: 'a lead' },
  'lead.view_notes': { kind: 'leads', verb: 'Read the notes on', noun: 'a lead' },
  'lead.note_add': { kind: 'leads', verb: 'Added a note to', noun: 'a lead' },
  'lead.note.delete.attempt': {
    kind: 'leads',
    verb: 'Started deleting a note on',
    noun: 'a lead',
  },
  'lead.note.delete.outcome': {
    kind: 'leads',
    verb: outcome('Deleted a note on', 'Could not delete a note on'),
    noun: 'a lead',
  },
  'crm.erase.attempt': { kind: 'leads', verb: 'Started erasing', noun: 'a lead' },
  'crm.erase.outcome': {
    kind: 'leads',
    verb: outcome('Erased', 'Could not erase'),
    noun: 'a lead',
  },
  'export.csv.attempt': { kind: 'leads', verb: 'Started exporting', noun: 'the leads' },
  'export.csv.outcome': {
    kind: 'leads',
    verb: outcome('Exported', 'Could not export'),
    noun: 'the leads',
  },

  // Users
  'user.invite': { kind: 'users', verb: 'Invited', noun: 'a new member' },
  'user.update': { kind: 'users', verb: 'Changed the account of', noun: 'a member' },
  'user.deactivate': { kind: 'users', verb: 'Switched off the account of', noun: 'a member' },
  // Admin v2 U12a (0055): the Security card, and handing ownership on (written by the RPC).
  'user.security_update': {
    kind: 'users',
    verb: 'Changed the security settings',
    noun: null,
  },
  'user.ownership_transfer': {
    kind: 'users',
    verb: 'Handed the account ownership to',
    noun: 'a member',
  },
  // Admin v2 U12b: invites sent again and cancelled, and an invite accepted (written by the
  // service role against the account that accepted it).
  'user.invite_resend': { kind: 'users', verb: 'Sent the invite again to', noun: 'a new member' },
  'user.invite_cancel': { kind: 'users', verb: 'Cancelled the invite of', noun: 'a new member' },
  'profile.update': { kind: 'users', verb: 'Changed their display name', noun: null },
  'auth.login': { kind: 'users', verb: 'Signed in', noun: null },
  'auth.logout': { kind: 'users', verb: 'Signed out', noun: null },
  'auth.password_change': { kind: 'users', verb: 'Changed their password', noun: null },
  'auth.password_change_refused': {
    kind: 'users',
    verb: 'Tried to change their password',
    noun: null,
  },
  'auth.password_reset_requested': {
    kind: 'users',
    verb: 'Asked for a password reset link',
    noun: null,
  },
  'auth.password_reset': { kind: 'users', verb: 'Reset their password', noun: null },
  'auth.invite_accepted': { kind: 'users', verb: 'Accepted their invite', noun: null },
  // Admin v2 U17 (0072): two factor authentication. Reset is written by public.reset_two_step
  // in the transaction that resets; on and off by the /admin/2fa page as the person.
  'auth.two_step_on': { kind: 'users', verb: 'Turned on 2FA', noun: null },
  'auth.two_step_off': { kind: 'users', verb: 'Turned off 2FA', noun: null },
  'user.two_step_reset': { kind: 'users', verb: 'Reset the 2FA of', noun: 'a member' },

  // Pending changes thrown away in one go (Admin v2 R3b): ids and types only, never values.
  'drafts.discard_bulk': {
    kind: 'edits',
    verb: 'Threw away several unpublished changes',
    noun: null,
  },
  // A version's content staged again as unpublished changes (Admin v2 R10): an edit until it is
  // published (the rollback is a release, a publish). Ids, counts and types only.
  'versions.restore': {
    kind: 'edits',
    verb: 'Restored',
    noun: (detail) => {
      const n = detail['number'];
      const which =
        typeof n === 'number' && Number.isInteger(n) && n > 0 ? `version ${n}` : 'a version';
      return detail['scope'] === 'page'
        ? `a page as it was in ${which}`
        : `${which} as unpublished changes`;
    },
  },

  // Settings
  // The job-application intake switch, written at once whatever the release flag (R3b).
  'site_profile.intake': {
    kind: 'settings',
    verb: (detail) =>
      detail['open'] === true ? 'Opened job applications' : 'Closed job applications',
    noun: null,
  },
  'maintenance.enable': { kind: 'settings', verb: 'Switched on', noun: 'maintenance mode' },
  'maintenance.disable': { kind: 'settings', verb: 'Switched off', noun: 'maintenance mode' },
  // Maintenance v2 (U9b): a change of the page or of who sees the site, and the cron's
  // switch-off on the "Back on" day.
  'maintenance.update': { kind: 'settings', verb: 'Changed', noun: 'the maintenance page' },
  'maintenance.auto_disable': {
    kind: 'settings',
    verb: 'Switched off by itself',
    noun: 'maintenance mode',
  },
  // Page visibility (U14a): the page is titled; a template is named by its kind.
  'page_visibility.update': {
    kind: 'settings',
    verb: (detail) =>
      detail['mode'] === 'hidden'
        ? 'Hid from the site'
        : detail['mode'] === 'link'
          ? 'Made link only'
          : 'Made visible to everyone',
    noun: (detail) =>
      detail['template'] === 'service'
        ? 'every service page'
        : detail['template'] === 'case_study'
          ? 'every case study page'
          : 'the page',
    titled: true,
  },
  'page_visibility.sync': { kind: 'settings', verb: 'Refreshed', noun: 'the live page visibility' },
  // Written by public.set_page_password itself (0061), in the transaction that sets the
  // password, so a change whose audit row cannot be chained does not happen. The row names
  // the page and the new version; it never names the password or the message.
  'page_visibility.password_set': {
    kind: 'settings',
    verb: 'Set a password on',
    noun: 'a page',
  },
  // CRM settings for leads (C9a): which card changed, never its values.
  'crm.settings.update': { kind: 'settings', verb: 'Changed', noun: 'the CRM settings' },
  'crm.stages.update': { kind: 'settings', verb: 'Changed', noun: 'the pipeline stages' },
  'logs.clear': { kind: 'settings', verb: 'Cleared', noun: 'old error logs' },
  'export.backup.attempt': { kind: 'settings', verb: 'Started downloading', noun: 'a backup' },
  'export.backup.outcome': {
    kind: 'settings',
    verb: outcome('Downloaded', 'Could not download', 'Downloaded part of'),
    noun: 'a backup',
  },
  'export.activity.attempt': {
    kind: 'settings',
    verb: 'Started exporting',
    noun: 'the activity log',
  },
  'export.activity.outcome': {
    kind: 'settings',
    verb: outcome('Exported', 'Could not export'),
    noun: 'the activity log',
  },
  'dashboard.defaults.update': {
    kind: 'settings',
    verb: 'Set the default dashboard of',
    noun: (detail) => roleNoun(detail),
  },
  'dashboard.defaults.reset': {
    kind: 'settings',
    verb: 'Reset the default dashboard of',
    noun: (detail) => roleNoun(detail),
  },
  'placeholder_override.grant': {
    kind: 'settings',
    verb: 'Allowed design samples to go live',
    noun: null,
  },
  'placeholder_override.revoke': {
    kind: 'settings',
    verb: 'Stopped design samples going live',
    noun: null,
  },

  // A release's cache purge (Admin v2 R7), written when a purge request was sent to the
  // cache after a publish: the pages the release changed, cleared from the cache. Only `done`
  // says it worked; a request the cache refused or that failed (a 429, a 5xx: the minute cron
  // tries again) says it did not.
  'release.purge': {
    kind: 'publishing',
    verb: (detail) => {
      const status = str(detail['status']);
      return status === null || status === 'done'
        ? 'Refreshed the cached pages of'
        : 'Could not refresh the cached pages of';
    },
    noun: versionNoun,
  },

  // Scheduling a release (Admin v2 R11), each written by the database in the same transaction
  // as the change it records, naming the person: a release scheduled, moved to another time,
  // or cancelled (its changes back to pending). A scheduled release that goes live writes
  // `release.publish`, naming its scheduler.
  'release.schedule': { kind: 'publishing', verb: 'Scheduled', noun: 'a release' },
  'release.reschedule': {
    kind: 'publishing',
    verb: 'Changed the time of',
    noun: 'a scheduled release',
  },
  'release.unschedule': { kind: 'publishing', verb: 'Unscheduled', noun: 'a release' },
  // The runbook's two switches (Admin v2 R11, launch runbook), run by the owner and naming the
  // operator.
  'releases.enable': {
    kind: 'settings',
    verb: 'Switched on publishing in releases',
    noun: null,
  },
  'releases.disable': {
    kind: 'settings',
    verb: 'Switched off publishing in releases',
    noun: null,
  },

  // Job applications (Admin only). No chip covers them: they show under All.
  'application.view': { kind: 'other', verb: 'Opened', noun: 'a job application' },
  'application.view_pii': {
    kind: 'other',
    verb: 'Revealed the contact details of',
    noun: 'an applicant',
  },
  'application.cv_download': { kind: 'other', verb: 'Downloaded the CV of', noun: 'an applicant' },
  'application.update': { kind: 'other', verb: 'Updated', noun: 'a job application' },
  'application.erase': { kind: 'other', verb: 'Erased', noun: 'a job application' },
};

/**
 * Actions known by their prefix: a release (`release.publish`, Admin v2 R4/R6) is a publish
 * of the whole site's pending changes, "Published version 15". R6 may give each kind of
 * release its own words; until then they read alike. `release.purge` (R7) has its own entry
 * in EXACT, which is read first.
 */
const PREFIXES: readonly { prefix: string; label: Label }[] = [
  {
    prefix: 'release.',
    label: { kind: 'publishing', verb: 'Published', noun: versionNoun },
  },
];

const KERNEL: ReadonlyMap<string, Label> = new Map(
  [...KERNEL_ENTITIES].flatMap(([entity, info]) => {
    const titled = hasTitleSource(entity);
    return [
      [`${entity}.create`, { kind: savedKind, verb: createVerb, noun: info.noun, titled }],
      [`${entity}.update`, { kind: savedKind, verb: updateVerb, noun: info.noun, titled }],
      // A deleted item has no row left to title.
      [`${entity}.delete`, { kind: 'edits', verb: 'Deleted', noun: info.noun }],
      [`${entity}.reorder`, { kind: 'edits', verb: 'Changed the order of', noun: info.list }],
      [
        `${entity}.draft_save`,
        {
          kind: 'edits',
          verb: draftSaveVerb,
          noun: (detail: Detail) => (str(detail['op']) === 'reorder' ? info.list : info.noun),
          titled,
        },
      ],
      [
        `${entity}.draft_discard`,
        { kind: 'edits', verb: 'Threw away unpublished changes to', noun: info.noun, titled },
      ],
    ] as [string, Label][];
  }),
);

const SINGLETON_LABELS: ReadonlyMap<string, Label> = new Map(
  Object.entries(SINGLETONS).map(([entity, { noun }]) => [
    `${entity}.update`,
    { kind: 'settings', verb: 'Updated', noun } satisfies Label,
  ]),
);

/** What a pending change of a release-managed type is a change to, in words. */
function draftNoun(type: string): Label['noun'] {
  const kernel = KERNEL_ENTITIES.get(type)?.noun;
  if (kernel) return kernel;
  if (Object.hasOwn(SINGLETONS, type)) return SINGLETONS[type]!.noun;
  if (type === 'entity_seo') {
    return (detail) => `the search details of ${nounOf(str(detail['target'])) ?? 'an item'}`;
  }
  if (type === 'page_visibility') return 'the page visibility';
  return `the ${type.replaceAll('_', ' ')}`;
}

/**
 * The pending-change actions of every release-managed type (Admin v2 R3): a change saved or
 * thrown away (the resource kernel's own are in KERNEL), a conflict settled, and an earlier
 * version restored (R10). Edits until they are published; a release is the publish.
 */
const DRAFT_LABELS: ReadonlyMap<string, Label> = new Map(
  RELEASE_ENTITY_TYPES.flatMap((type) => {
    const noun = draftNoun(type);
    const titled = hasTitleSource(type);
    const labels: [string, Label][] = [
      [`${type}.draft_resolve`, { kind: 'edits', verb: 'Settled a conflict on', noun, titled }],
      // One item's earlier version staged again (Admin v2 R10, the history drawer's Restore).
      [
        `${type}.history_restore`,
        { kind: 'edits', verb: 'Restored an earlier version of', noun, titled },
      ],
    ];
    if (!KERNEL.has(`${type}.draft_save`)) {
      labels.push([`${type}.draft_save`, { kind: 'edits', verb: draftSaveVerb, noun, titled }]);
    }
    if (!KERNEL.has(`${type}.draft_discard`)) {
      labels.push([
        `${type}.draft_discard`,
        { kind: 'edits', verb: 'Threw away unpublished changes to', noun, titled },
      ]);
    }
    return labels;
  }),
);

/** The label of an action, or null when the registry does not know it. */
function labelOf(action: string): Label | null {
  return (
    KERNEL.get(action) ??
    DRAFT_LABELS.get(action) ??
    SINGLETON_LABELS.get(action) ??
    EXACT[action] ??
    PREFIXES.find((p) => action.startsWith(p.prefix))?.label ??
    null
  );
}

/** Does the registry describe this action (exactly, or by its prefix)? */
export function hasLabel(action: string): boolean {
  return labelOf(action) !== null;
}

// ── Field names ──────────────────────────────────────────────────────────────────────────

/** A stored key the page may show: lower-case words joined by underscores. */
const PLAIN_KEY = /^[a-z][a-z0-9_]{0,62}$/;
/** An action the fallback may spell out: plain keys joined by dots. */
const PLAIN_ACTION = /^[a-z][a-z0-9_]{0,40}(\.[a-z][a-z0-9_]{0,40}){0,4}$/;

/** Columns a save writes alongside the one the editor named (the HTML cache of a body). */
const DERIVED_FIELDS = new Set(['body_html']);

/** The lead pipeline's columns, as the leads screen names them. */
const LEAD_FIELDS: Readonly<Record<string, string>> = {
  stage_id: 'Stage',
  assigned_to: 'Assignee',
  is_spam: 'Spam',
  value_sar: 'Value (SAR)',
  internal_notes: 'Notes',
  read_at: 'Read',
  is_starred: 'Star',
};

/** The most field names one row shows; more read as "and N more". */
export const MAX_FIELDS = 12;

function words(key: string): string {
  const text = key.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const NO_LABELS: ReadonlyMap<string, string> = new Map();
const labelCache = new Map<string, ReadonlyMap<string, string>>();

/**
 * The editor's label for each column of an entity, dashes the copy rules forbid made plain.
 * Built once per entity (an export describes up to 1,000 rows on the Free plan's 10 ms).
 */
function fieldLabels(entity: string | null): ReadonlyMap<string, string> {
  if (!entity) return NO_LABELS;
  const cached = labelCache.get(entity);
  if (cached) return cached;
  const fields =
    KERNEL_ENTITIES.get(entity)?.fields ??
    (Object.hasOwn(SINGLETONS, entity)
      ? (SINGLETON_UI[SINGLETONS[entity]!.ui]?.fields ?? [])
      : null);
  if (!fields) return NO_LABELS;
  const labels = new Map(
    fields.map((field) => [columnOf(field), field.label.replace(/[–—]/g, '-')]),
  );
  labelCache.set(entity, labels);
  return labels;
}

/** The names of the fields a row says a save changed, in words; anything else is dropped. */
export function changedFields(row: Pick<ActivityRow, 'entity_type' | 'detail'>): string[] {
  const detail = isRecord(row.detail) ? row.detail : {};
  const raw = Array.isArray(detail['fields']) ? (detail['fields'] as unknown[]) : [];
  const labels = fieldLabels(row.entity_type);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of raw) {
    if (typeof key !== 'string' || !PLAIN_KEY.test(key) || DERIVED_FIELDS.has(key)) continue;
    const name = labels.get(key) ?? LEAD_FIELDS[key] ?? words(key);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (out.length <= MAX_FIELDS) return out;
  return [...out.slice(0, MAX_FIELDS - 1), `and ${out.length - (MAX_FIELDS - 1)} more`];
}

// ── Describing a row ─────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const resolve = <T>(value: T | ((detail: Detail) => T), detail: Detail): T =>
  typeof value === 'function' ? (value as (detail: Detail) => T)(detail) : value;

/** The item a titled row may show the title of; entity SEO titles its target. */
function titleRefOf(
  row: ActivityRow,
  label: Label,
  detail: Detail,
): ActivityDescription['titleRef'] {
  const id = row.entity_id;
  if (!id) return null;
  // Entity SEO's rows (its save, and its pending changes since R3b) name the target's id.
  if (row.action.startsWith('entity_seo.')) {
    const target = str(detail['target']);
    return target && hasTitleSource(target) ? { type: target, id } : null;
  }
  if (!label.titled || !row.entity_type || !hasTitleSource(row.entity_type)) return null;
  return { type: row.entity_type, id };
}

/** One row in plain words. Unknown actions read "Did <the action's words>", kind `other`. */
export function describe(row: ActivityRow): ActivityDescription {
  const detail: Detail = isRecord(row.detail) ? row.detail : {};
  const action = typeof row.action === 'string' ? row.action : '';
  const label = labelOf(action);
  if (!label) {
    return {
      kind: 'other',
      verb: 'Did',
      noun: PLAIN_ACTION.test(action)
        ? action.replace(/[._]/g, ' ')
        : 'something the log cannot describe',
      titleRef: null,
      fields: changedFields(row),
    };
  }
  return {
    kind: resolve(label.kind, detail),
    verb: resolve(label.verb, detail),
    noun: resolve(label.noun, detail),
    titleRef: titleRefOf(row, label, detail),
    fields: changedFields(row),
  };
}

/** "Updated the service", with the title when there is one: the CSV's `what`. */
export function sentence(description: ActivityDescription, title: string | null = null): string {
  const parts = [description.verb, description.noun].filter(Boolean).join(' ');
  return title ? `${parts} "${title}"` : parts;
}

// ── The chips' SQL ───────────────────────────────────────────────────────────────────────

/** Every action the registry knows by its exact key, with its fixed kind or `null` (by status). */
function exactKinds(): Map<string, ActivityRowKind | null> {
  const out = new Map<string, ActivityRowKind | null>();
  for (const [action, label] of [
    ...KERNEL,
    ...DRAFT_LABELS,
    ...SINGLETON_LABELS,
    ...Object.entries(EXACT),
  ]) {
    out.set(action, typeof label.kind === 'function' ? null : label.kind);
  }
  return out;
}

/** The kernel's saves, whose kind is their status (edits or publishing). */
export const KERNEL_SAVES: readonly string[] = [...KERNEL]
  .filter(([, label]) => typeof label.kind === 'function')
  .map(([action]) => action)
  .sort();

/** The actions of a fixed kind, sorted: what a chip filters on, besides the kernel's saves. */
export function actionsOfKind(kind: ActivityRowKind): string[] {
  return [...exactKinds()]
    .filter(([, k]) => k === kind)
    .map(([action]) => action)
    .sort();
}

/** The prefixes a kind also covers (a release is a publish). */
export function prefixesOfKind(kind: ActivityRowKind): string[] {
  return PREFIXES.filter((p) => p.label.kind === kind).map((p) => p.prefix);
}

/**
 * A chip's filter, as the PostgREST `or` expression `loadActivity` hands `.or()`: the actions
 * of its kind, the prefixes it covers, and, for Edits and Publishing, the kernel's saves told
 * apart by the status a save recorded. Every action is a plain key (checked by the spec), so
 * nothing here needs quoting.
 */
export function kindFilter(kind: ActivityKind): string {
  const parts: string[] = [];
  const exact = actionsOfKind(kind);
  if (exact.length > 0) parts.push(`action.in.(${exact.join(',')})`);
  for (const prefix of prefixesOfKind(kind)) parts.push(`action.like.${prefix}*`);
  const saves = `action.in.(${KERNEL_SAVES.join(',')})`;
  const statuses = `(${PUBLISHING_STATUSES.join(',')})`;
  if (kind === 'publishing') parts.push(`and(${saves},detail->>status.in.${statuses})`);
  if (kind === 'edits') {
    parts.push(`and(${saves},or(detail->>status.is.null,detail->>status.not.in.${statuses}))`);
  }
  return parts.join(',');
}
