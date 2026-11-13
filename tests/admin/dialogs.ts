import { ROLE_CAPS, type Access, type Capability } from '@/lib/authz/matrix';
import type { Role } from '@/lib/auth/types';

/*
 * The per-role axe matrix with dialogs open (Admin v2 Z1, ui.md AV-34): which dialog each
 * admin screen opens, how, and for whom. tests/admin/dialogs.e2e.ts opens every case for every
 * role whose sweep has the case's screen (tests/admin/routes.ts sweepRoutes, so the matrix
 * follows the sidebar) and who sees its trigger (`who`, from ROLE_CAPS); the F0 sweep already
 * runs axe on each screen as it loads, so the matrix only opens the dialogs.
 *
 * The steps are the accessible names in the markup, traced against the components and the
 * feature specs that already press them (named on each case). tests/lib/adminDialogs.spec.ts
 * holds the registry complete: every admin source file that renders a dialog is a case's
 * `sources`, a DIALOGS_COVERED_ELSEWHERE entry, or a primitive (DIALOG_PRIMITIVES).
 */

export type AriaRole =
  'button' | 'link' | 'tab' | 'textbox' | 'group' | 'region' | 'complementary' | 'list' | 'toolbar';

/** An element on the page: by its role and accessible name, or by CSS; inside another. */
export type Target =
  | {
      role: AriaRole;
      name: string | RegExp;
      exact?: boolean;
      /** The first of several matches (a list's rows). */
      first?: boolean;
      within?: Target;
    }
  | { css: string; first?: boolean; within?: Target };

export type Step =
  /** A click. `optional`: only when the target is shown (the phone's Menu button). */
  | { click: Target; optional?: boolean }
  /** Focus, then Enter: a row action (the kit's rule: hover arms a pointer press late). */
  | { press: Target }
  /** Keys pressed on the page. */
  | { keys: string };

export interface DialogCase {
  /** Unique: the test title's key. */
  id: string;
  /**
   * The screen, as the sweep names it (routeKey): the path visited, or an edit screen's
   * pattern (`/admin/services/[id]`), whose row is the role's first unless `slug` names one.
   */
  screen: string;
  /** An edit screen opened on its row with this slug (the page editor on About). */
  slug?: string;
  /** Who sees the trigger, beyond the screen being on the role's sweep. */
  who: (role: Role) => boolean;
  open: readonly Step[];
  /** The open dialog's accessible name, when the case knows it (else: any non-empty name). */
  name?: string | RegExp;
  /** A popover instead of a <dialog> (the phone sidebar): its CSS, open as :popover-open. */
  popover?: string;
  /** Viewport widths; the default is the laptop's. */
  widths?: readonly number[];
  /** The source files whose dialog this opens (held complete by adminDialogs.spec.ts). */
  sources: readonly string[];
  /** A screen with E2's live preview frame: axe also scans the public page inside it. */
  slow?: boolean;
}

export const LAPTOP = 1440;
export const PHONE = 390;

const access =
  (cap: Capability, ...levels: Access[]) =>
  (role: Role) =>
    levels.includes(ROLE_CAPS[role][cap]);
const full = (cap: Capability) => access(cap, 'full');
const anyFull =
  (...caps: Capability[]) =>
  (role: Role) =>
    caps.some((cap) => ROLE_CAPS[role][cap] === 'full');
const everyone = () => true;

const C = 'src/components/admin/screens';
const topbar: Target = { css: '.admin-topbar' };
/** The phone's Menu button, which reveals the sidebar popover (hidden from 900 px). */
const MENU: Step = { click: { role: 'button', name: 'Menu', within: topbar }, optional: true };

/** The six collections on the generic collection screen (Admin v2 U7). */
const COLLECTIONS = [
  'faq',
  'testimonials',
  'clients',
  'team',
  'statistics',
  'certifications',
] as const;

export const DIALOG_CASES: readonly DialogCase[] = [
  // ---- The shell, on every screen: checked on the dashboard, every role, both widths ----
  // palette.e2e.ts, help.e2e.ts and personal.e2e.ts open these for some roles at one width.
  {
    id: 'shell-palette',
    screen: '/admin',
    who: everyone,
    open: [{ click: { role: 'link', name: /^Search anything/, within: topbar } }],
    name: 'Search the admin',
    widths: [LAPTOP, PHONE],
    sources: [`${C}/chrome/CommandPalette.tsx`],
  },
  {
    id: 'shell-help',
    screen: '/admin',
    who: everyone,
    open: [{ click: { role: 'link', name: 'Help centre', within: topbar } }],
    name: 'Help centre',
    widths: [LAPTOP, PHONE],
    sources: [`${C}/help/HelpDrawer.tsx`],
  },
  {
    id: 'shell-notifications',
    screen: '/admin',
    who: everyone,
    open: [{ click: { role: 'link', name: /^Notifications/, within: topbar } }],
    name: 'Notifications',
    widths: [LAPTOP, PHONE],
    sources: [`${C}/chrome/NotificationsDrawer.tsx`],
  },
  {
    id: 'shell-account',
    screen: '/admin',
    who: everyone,
    // On a phone the account chip sits in the sidebar popover: Menu first.
    open: [MENU, { click: { css: '.side__user[data-open="account"]' } }],
    name: 'Your account',
    widths: [LAPTOP, PHONE],
    sources: [`${C}/chrome/AccountDrawer.tsx`],
  },
  {
    id: 'shell-menu',
    screen: '/admin',
    who: everyone,
    open: [{ click: { role: 'button', name: 'Menu', within: topbar } }],
    popover: '#admin-side',
    widths: [PHONE],
    sources: [],
  },

  // ---- The dashboard (U1; dashboard.e2e.ts opens these as Admin) ------------------------
  {
    id: 'dashboard-add-widget',
    screen: '/admin',
    who: everyone,
    open: [
      { click: { role: 'button', name: 'Customize', exact: true } },
      { click: { role: 'button', name: 'Add widget' } },
    ],
    name: 'Add a widget',
    sources: [`${C}/dashboard/AddWidgetDrawer.tsx`],
  },
  {
    id: 'dashboard-reset',
    screen: '/admin',
    who: everyone,
    open: [
      { click: { role: 'button', name: 'Customize', exact: true } },
      { click: { role: 'button', name: 'Reset', exact: true } },
    ],
    name: 'Reset the dashboard?',
    sources: [`${C}/dashboard/ResetModal.tsx`],
  },
  {
    id: 'dashboard-role-defaults',
    screen: '/admin',
    // The presets are the account owner's tool: users.manage (src/pages/admin/index.astro).
    who: full('users.manage'),
    open: [
      { click: { role: 'button', name: 'Customize', exact: true } },
      { click: { role: 'button', name: 'Save as the default for a role' } },
    ],
    name: 'Save as the default for a role',
    sources: [`${C}/dashboard/RoleDefaultsModal.tsx`],
  },
  {
    id: 'dashboard-quick-actions',
    screen: '/admin',
    // Quick actions are on every role's default board (src/lib/admin/dashboard/widgets.ts).
    who: everyone,
    open: [{ click: { role: 'button', name: 'Customize quick actions' } }],
    name: 'Customize quick actions',
    sources: [`${C}/dashboard/QuickActionsDrawer.tsx`],
  },

  // ---- The component kit (F4b, F5a). Its sample modal, drawer and arrange drawer are made-up
  // data, the same for every role: kit.e2e.ts opens them with axe (DIALOGS_COVERED_ELSEWHERE).
  // The rich-text link dialog is the one real editors use, and its page picker reads what the
  // role may link to, so it runs for every role.
  {
    id: 'kit-link-dialog',
    screen: '/admin/kit',
    who: everyone,
    open: [
      {
        click: {
          role: 'textbox',
          name: 'Sample body English',
          within: { role: 'region', name: 'Fields', exact: true },
        },
      },
      { keys: 'End' },
      {
        click: {
          role: 'button',
          name: 'Link',
          within: {
            role: 'toolbar',
            name: 'Sample body English formatting',
            within: { role: 'region', name: 'Fields', exact: true },
          },
        },
      },
    ],
    name: 'Add a link',
    sources: ['src/components/admin/fields/LinkDialog.tsx'],
  },

  // ---- Pages and the page editor (E1, E2, E11; pages.e2e.ts) ---------------------------
  {
    id: 'pages-new-page',
    screen: '/admin/pages',
    who: full('pages.write'),
    open: [{ click: { role: 'button', name: 'New page' } }],
    name: 'New page',
    sources: [`${C}/newPage/NewPage.tsx`],
  },
  {
    id: 'page-editor-seo',
    screen: '/admin/pages/[id]',
    slug: 'about',
    who: full('pages.write'),
    open: [
      {
        click: {
          role: 'button',
          name: 'SEO',
          within: { role: 'group', name: 'This page' },
        },
      },
    ],
    name: 'SEO: About',
    sources: [`${C}/seo/SeoDrawer.tsx`, `${C}/seo/SeoPanel.tsx`],
    slow: true,
  },
  {
    id: 'page-editor-seo-role',
    screen: '/admin/pages/[id]',
    slug: 'about',
    // SEO edits a page's search settings only: no sections column, the drawer from its card.
    who: (role) => !full('pages.write')(role) && full('seo.entityMeta')(role),
    open: [{ click: { role: 'button', name: 'Edit SEO' } }],
    name: 'SEO: About',
    sources: [`${C}/seo/SeoDrawer.tsx`, `${C}/seo/SeoPanel.tsx`],
    slow: true,
  },
  {
    id: 'page-editor-history',
    screen: '/admin/pages/[id]',
    slug: 'about',
    who: full('pages.write'),
    open: [
      {
        click: {
          role: 'button',
          name: 'History',
          within: { role: 'group', name: 'This page' },
        },
      },
    ],
    name: /^History: /,
    sources: [`${C}/pageEditor/HistoryDrawer.tsx`],
    slow: true,
  },
  {
    id: 'page-editor-add-section',
    screen: '/admin/pages/[id]',
    slug: 'about',
    who: full('pages.write'),
    open: [
      {
        click: {
          role: 'button',
          name: 'Add section',
          within: { role: 'complementary', name: 'Sections' },
        },
      },
    ],
    name: 'Add a section',
    sources: [`${C}/pageEditor/AddSectionModal.tsx`],
    slow: true,
  },
  {
    id: 'page-editor-rename',
    screen: '/admin/pages/[id]',
    slug: 'about',
    who: full('pages.write'),
    // About opens on its first section (Who we are), whose card holds Rename.
    open: [{ click: { role: 'button', name: 'Rename' } }],
    name: 'Rename section',
    sources: [`${C}/pageEditor/RenameModal.tsx`],
    slow: true,
  },

  // ---- Services and projects (U5, U6; services.e2e.ts, projects.e2e.ts, backups.e2e.ts) --
  {
    id: 'services-add',
    // Add service is the page head's link on a discipline's page (src/pages/admin/disciplines/
    // [id].astro, drawn for services.write), not on the Services overview, whose only add
    // control is Add discipline; services.e2e.ts presses it there too.
    screen: '/admin/disciplines/[id]',
    who: full('services.write'),
    open: [{ click: { role: 'link', name: 'Add service' } }],
    name: 'Add a service',
    sources: [`${C}/services/AddServiceModal.tsx`],
  },
  {
    id: 'services-discipline',
    screen: '/admin/services',
    who: anyFull('services.write', 'seo.entityMeta'),
    // "Edit discipline …" for a writer, "Open discipline …" for SEO.
    open: [{ press: { role: 'button', name: /^(Edit|Open) discipline /, first: true } }],
    name: /^Edit discipline: /,
    sources: [`${C}/services/DisciplineDrawer.tsx`],
  },
  {
    id: 'service-history',
    screen: '/admin/services/[id]',
    who: everyone,
    // The record's own History, not its search settings' (backups.e2e.ts, R14-prep).
    open: [{ click: { role: 'button', name: /^History of (?!Search settings for )/ } }],
    name: /^History: /,
    sources: [`${C}/history/HistoryDrawer.tsx`],
  },
  {
    id: 'service-poster-picker',
    screen: '/admin/services/[id]',
    who: full('services.write'),
    open: [
      {
        click: {
          role: 'button',
          name: /^(Choose|Change)…$/,
          within: { role: 'group', name: 'Poster' },
        },
      },
    ],
    name: 'Poster: choose',
    sources: [
      'src/components/admin/fields/media/MediaPicker.tsx',
      'src/components/admin/fields/media/BodyPortal.tsx',
    ],
  },
  {
    id: 'projects-tags',
    screen: '/admin/portfolio',
    who: anyFull('portfolio.write', 'categories.manage'),
    open: [{ click: { role: 'link', name: 'Manage tags' } }],
    name: 'Tags and filters',
    sources: [`${C}/projects/TagsDrawer.tsx`],
  },
  {
    id: 'projects-add',
    screen: '/admin/portfolio',
    who: full('portfolio.write'),
    open: [{ click: { role: 'link', name: 'Add project' } }],
    name: 'Add a project',
    sources: [`${C}/projects/AddProjectModal.tsx`],
  },

  // ---- The collections (U7; collections.e2e.ts, faq.e2e.ts): a row, and Add ------------
  // Each collection's drawer holds its own fields: a row of each.
  ...COLLECTIONS.map((slug): DialogCase => ({
    id: `collection-${slug}-row`,
    screen: `/admin/${slug}`,
    who: everyone,
    open: [{ click: { css: 'ul.coll__list > li a.li__t', first: true } }],
    sources: [`${C}/collection/CollectionDrawer.tsx`],
  })),
  // Add opens the same drawer empty: one collection is enough.
  {
    id: 'collection-faq-add',
    screen: '/admin/faq',
    who: everyone,
    open: [{ click: { css: '[data-collection-add]' } }],
    sources: [`${C}/collection/CollectionDrawer.tsx`],
  },

  // ---- Media (U4; media.e2e.ts) ---------------------------------------------------------
  {
    id: 'media-drawer',
    screen: '/admin/media',
    who: everyone,
    // A picture's drawer, named for it: the grid's first tile.
    open: [
      {
        click: {
          role: 'button',
          name: /\S/,
          first: true,
          within: { role: 'list', name: 'Pictures' },
        },
      },
    ],
    sources: [`${C}/media/MediaDrawer.tsx`],
  },

  // ---- Leads (C4b; leads.e2e.ts) --------------------------------------------------------
  {
    id: 'leads-add',
    screen: '/admin/leads',
    // The page head's button is drawn for leads.pii holders (src/pages/admin/leads/index.astro).
    who: full('leads.pii'),
    open: [{ click: { role: 'button', name: 'Add lead manually' } }],
    name: 'Add a lead manually',
    sources: [`${C}/leads/AddLeadDrawer.tsx`, `${C}/leads/shared.tsx`],
  },

  // ---- Contacts (C7; contacts.e2e.ts) ---------------------------------------------------
  {
    id: 'contacts-add',
    screen: '/admin/contacts',
    // The page head's button is drawn for crm.contacts holders (src/pages/admin/contacts/index.astro).
    who: full('crm.contacts'),
    open: [{ click: { role: 'button', name: 'Add contact', exact: true } }],
    name: 'Add a contact',
    sources: [`${C}/contacts/AddContactDrawer.tsx`],
  },
  {
    id: 'contacts-new-lead',
    screen: '/admin/contacts/[id]',
    // The Leads card's button: crm.contacts with leads.manage and leads.pii (the route's caps).
    who: (role) =>
      full('crm.contacts')(role) && full('leads.manage')(role) && full('leads.pii')(role),
    open: [{ click: { role: 'button', name: 'New lead', exact: true } }],
    name: /^New lead for /,
    sources: [`${C}/contacts/NewLeadDrawer.tsx`],
  },
  // Admin v2 C11 (companies.e2e.ts): the Companies tab's head button, for crm.contacts holders
  // (src/pages/admin/contacts/companies.astro).
  {
    id: 'companies-new',
    screen: '/admin/contacts/companies',
    who: full('crm.contacts'),
    open: [{ click: { role: 'button', name: 'Add company', exact: true } }],
    name: 'New company',
    sources: [`${C}/contacts/CompanyDrawer.tsx`],
  },

  // ---- Tasks (C8; tasks.e2e.ts) -----------------------------------------------------------
  {
    id: 'tasks-new',
    screen: '/admin/tasks',
    // The screen is crm.tasks's (Admin and, since C10b, Sales); its New task button opens it.
    who: full('crm.tasks'),
    open: [{ click: { role: 'button', name: 'New task' } }],
    name: 'New task',
    sources: [`${C}/tasks/TaskDrawer.tsx`, `${C}/tasks/TasksScreen.tsx`],
  },

  // ---- Website stats: goals (G1; stats-v2.e2e.ts) ---------------------------------------
  {
    id: 'stats-new-goal',
    screen: '/admin/analytics?tab=conversions&range=7',
    who: full('analytics.goals'),
    open: [{ click: { role: 'button', name: 'Add goal' } }],
    name: 'New goal',
    sources: [`${C}/goals/StatsGoals.tsx`],
  },

  // ---- SEO (U10; seo.e2e.ts) ------------------------------------------------------------
  {
    id: 'seo-entity-drawer',
    screen: '/admin/seo?tab=pages&type=service',
    who: full('seo.entityMeta'),
    open: [{ press: { role: 'button', name: /^Edit SEO for /, first: true } }],
    name: /^SEO: /,
    sources: [`${C}/seo/SeoDrawer.tsx`, `${C}/seo/SeoPanel.tsx`],
  },
  {
    id: 'seo-new-redirect',
    screen: '/admin/seo?tab=redirects',
    who: full('redirects.manage'),
    open: [{ click: { role: 'button', name: 'New redirect' } }],
    name: 'New redirect',
    sources: [`${C}/seo/RedirectsTab.tsx`],
  },

  // ---- Page visibility (U14; visibility.e2e.ts) -----------------------------------------
  {
    id: 'visibility-drawer',
    screen: '/admin/visibility',
    who: everyone,
    open: [{ click: { role: 'button', name: 'Change who can see Join us', exact: true } }],
    name: 'Who can see Join us?',
    sources: [`${C}/visibility/VisibilityDrawer.tsx`],
  },

  // ---- The shared confirm (src/lib/admin/confirm.ts), from a list's Delete --------------
  {
    id: 'confirm-delete',
    screen: '/admin/categories',
    // ResourceTable draws Delete for everyone who opens the list (the server answers
    // content.archiveDelete); the confirm comes first, and Escape cancels: nothing is sent.
    who: everyone,
    open: [{ press: { role: 'button', name: /^Delete /, first: true } }],
    sources: ['src/lib/admin/confirm.ts'],
  },
];

/**
 * Dialogs the matrix does not open itself, each opened with axe by the spec named, for the roles
 * named, because opening it here would need a write, a row a spec makes, releases switched on,
 * or would take the shared preview down. tests/lib/adminDialogs.spec.ts checks that each spec
 * exists, names the dialog (`marker`, as the spec spells it) and runs axe.
 */
export interface CoveredElsewhere {
  source: string;
  spec: string;
  marker: string;
  roles: readonly Role[];
  why: string;
}

export const DIALOGS_COVERED_ELSEWHERE: readonly CoveredElsewhere[] = [
  {
    source: `${C}/tasks/TasksCard.tsx`,
    spec: 'tests/admin/tasks.e2e.ts',
    marker: "card.getByRole('button', { name: 'Add a task' })",
    roles: ['admin'],
    why: 'the Tasks card on a lead’s page needs a lead, which the spec adds through /api/admin/leads; the drawer it opens is the tasks-new case’s, with axe there',
  },
  {
    source: `${C}/kit/KitGallery.tsx`,
    spec: 'tests/admin/kit.e2e.ts',
    marker: "name: 'Rename the sample'",
    roles: ['admin'],
    why: 'the kit’s sample modal, drawer and arrange drawer show made-up data, the same for every role; the spec opens each with axe (the rich-text link dialog on the same page is a matrix case)',
  },
  {
    source: `${C}/applications/ApplicationDrawer.tsx`,
    spec: 'tests/admin/applications.e2e.ts',
    marker: "page.getByRole('dialog', { name: NAME })",
    roles: ['admin'],
    why: 'needs an application, which the spec sends through /api/apply; Admin alone holds applications.manage',
  },
  {
    source: `${C}/integrations/IntegrationDrawer.tsx`,
    spec: 'tests/admin/integrations.e2e.ts',
    marker: "page.getByRole('dialog', { name })",
    roles: ['admin', 'seo'],
    why: 'already opened for every role that holds settings.integrations, at 320, 390 and 1280 px',
  },
  {
    source: `${C}/users/InviteDrawer.tsx`,
    spec: 'tests/admin/invites.e2e.ts',
    marker: "name: 'Invite someone'",
    roles: ['admin'],
    why: 'Admin alone holds users.manage; the spec opens it at every width with e-mail set up',
  },
  {
    source: `${C}/users/PendingInvites.tsx`,
    spec: 'tests/admin/invites.e2e.ts',
    marker: "name: 'Cancel invite?'",
    roles: ['admin'],
    why: 'needs a pending invite, which the spec makes',
  },
  {
    source: `${C}/users/EditUserDrawer.tsx`,
    spec: 'tests/admin/users.e2e.ts',
    marker: "name: 'Edit user'",
    roles: ['admin'],
    why: 'needs the account the spec edits; its confirms (remove access, make owner) are opened there too, and Reset 2FA in twoStep.e2e.ts',
  },
  {
    source: `${C}/users/SecurityCard.tsx`,
    spec: 'tests/admin/users.e2e.ts',
    marker: "name: 'Require 2FA for everyone?'",
    roles: ['admin'],
    why: 'opens from a switch whose confirm the spec answers',
  },
  {
    source: `${C}/leads/EraseLeadDialog.tsx`,
    spec: 'tests/admin/leads.e2e.ts',
    marker: "name: 'Erase this lead'",
    roles: ['admin'],
    why: 'needs a lead of its own to erase; Admin alone holds crm.erase',
  },
  {
    source: `${C}/contacts/EraseContactDialog.tsx`,
    spec: 'tests/admin/contacts.e2e.ts',
    marker: "name: 'Erase everything about them'",
    roles: ['admin'],
    why: 'opening it asks the erasure preview, which spends a slot of its own hourly limit, and its spec erases a contact of its own; Admin alone holds crm.erase',
  },
  // Admin v2 C9b: the erasure's first step from CRM settings (find the person).
  {
    source: `${C}/crmSettings/EraseFinder.tsx`,
    spec: 'tests/admin/crm-custom-fields.e2e.ts',
    marker: `name: "Erase a person's data"`,
    roles: ['admin'],
    why: 'its pick opens the erase dialog, whose preview spends a slot of its own hourly limit; the spec finds a contact of its own with it open; Admin alone holds crm.erase',
  },
  {
    source: `${C}/maintenance/TurnOnDialog.tsx`,
    spec: 'tests/admin/maintenance.e2e.ts',
    marker: "name: 'Put the site in maintenance mode?'",
    roles: ['admin'],
    why: 'a slip would take the shared preview down for every spec running beside it: maintenance has its own project, last of all (Developer holds the same switch and sees the same dialog)',
  },
  {
    source: `${C}/visibility/VisibilityScreen.tsx`,
    spec: 'tests/admin/visibility.e2e.ts',
    marker: "name: 'Only people with the link?'",
    roles: ['admin'],
    why: 'opens on Apply, which hides a page from every spec: page visibility has its own project (Developer sees the same dialog)',
  },
  {
    source: 'src/components/admin/fields/media/UploadDialog.tsx',
    spec: 'tests/admin/media.e2e.ts',
    marker: "name: 'Describe your images'",
    roles: ['admin'],
    why: 'opens after a file is chosen, which the spec does with a generated picture',
  },
  {
    source: `${C}/logs/ClearLogs.tsx`,
    spec: 'tests/admin/stats-health.e2e.ts',
    marker: "name: 'Clear logs'",
    roles: ['admin'],
    why: 'Admin alone holds logs.clear',
  },
  {
    source: `${C}/goals/StatsGoals.tsx`,
    spec: 'tests/admin/stats-v2.e2e.ts',
    marker: "name: 'Delete this goal?'",
    roles: ['admin'],
    why: 'the delete confirm needs a goal, which the spec adds and deletes (the New goal drawer is a matrix case)',
  },
  {
    source: `${C}/seo/SiteWideForm.tsx`,
    spec: 'tests/admin/seo.e2e.ts',
    marker: "name: 'Hide the whole site from search engines?'",
    roles: ['admin'],
    why: 'opens on a save that would hide the site from search engines; seo.e2e.ts runs in both modes since R14d (R14b owner item B2)',
  },
  {
    source: `${C}/release/PublishDialog.tsx`,
    spec: 'tests/admin/releases-ui.e2e.ts',
    marker: "name: 'Publish to the website'",
    roles: ['admin', 'content_creator'],
    why: 'drawn only while releases are on (the rehearsal); releases stay off in the required job',
  },
  {
    source: `${C}/versions/Versions.tsx`,
    spec: 'tests/admin/backups.e2e.ts',
    marker: "name: 'Change time'",
    roles: ['admin'],
    why: 'needs a scheduled release, which exists only while releases are on (the rehearsal)',
  },
];

/** The primitives every case exercises: they draw no dialog of their own. */
export const DIALOG_PRIMITIVES: readonly string[] = [
  'src/components/admin/kit/Drawer.tsx',
  'src/components/admin/kit/Modal.tsx',
  'src/components/admin/kit/useDialog.ts',
  `${C}/chrome/ChromeDrawer.tsx`,
];

/** The cases a role meets on its swept screens (`screens`: the sweep's route keys). */
export function casesFor(role: Role, screens: ReadonlySet<string>): DialogCase[] {
  return DIALOG_CASES.filter((c) => screens.has(c.screen) && c.who(role));
}
