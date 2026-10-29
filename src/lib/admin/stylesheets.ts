// The admin's screen stylesheets (Admin v2 W0): public/styles/admin/<name>, each holding
// what only one screen renders, linked after admin.css through AdminLayout's `styles`
// prop. A closed list, like BaseLayout's route stylesheets: a typo fails `astro check`,
// and tests/lib/adminStyles.spec.ts holds this list equal to the files and checks that
// every class a sheet alone styles renders only on pages that link it.
//
// A new screen sheet is its file in public/styles/admin/ and one line here. Tokens, the
// fonts, the chrome, the design system's hooks (docs/admin-v2/ui.md §1.2, the bars among
// them) and anything two screens share stay in admin.css.

export const ADMIN_STYLESHEETS = [
  'activity.css',
  'applications.css',
  'collection.css',
  'crm-settings.css',
  'dashboard.css',
  'forms.css',
  'general.css',
  'health.css',
  'help.css',
  'integrations.css',
  'kit.css',
  'leads.css',
  'login.css',
  'maintenance.css',
  'media.css',
  'pages.css',
  'personal.css',
  'projects.css',
  'search.css',
  'seo.css',
  'services.css',
  'stats.css',
  // Admin v2 E4: the theme editor.
  'theme.css',
  'two-step.css',
  'users.css',
  // Admin v2 R13: Backups & versions (and the kit's gallery, which draws its list).
  'versions.css',
  'visibility.css',
] as const;

export type AdminStylesheet = (typeof ADMIN_STYLESHEETS)[number];
