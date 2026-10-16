// Page visibility's words (Admin v2 U14a), shared by the route that refuses and the screen
// that explains: plain strings only, so the island imports them without the server code.
// The prototype's copy (screens_cms.js, visibilityDrawer), with "after you publish" made
// "within a few minutes" until releases switch on (decision D7; docs/admin-v2/deviations.md).

/** What the admin shows when the homepage is asked to be anything but visible. */
export const HOME_REFUSAL = 'The homepage cannot be hidden. Use maintenance mode instead.';

/**
 * How soon a change reaches the live site: the bound src/lib/http/visibility.ts states (the
 * isolate memo, KV's edge cache and KV's own propagation, about three minutes at worst).
 */
export const APPLIES_WITHIN = 'Applies to the live site within a few minutes.';

/** The confirm before a change goes live. */
export const CONFIRM_SUB = 'This changes the live site within a few minutes.';

export const MODE_COPY = {
  public: {
    title: 'Visible to everyone',
    text: 'Normal. In the menu, in search engines, open to all.',
    badge: 'Visible',
  },
  hidden: {
    title: 'Hidden from the site',
    text: 'Removed from the menu and search engines. Anyone who opens the link is sent to a page you choose, or sees a page not found screen.',
    badge: 'Hidden',
  },
  link: {
    title: 'Only people with the link',
    text: 'Not in the menu or search engines, but the link works. Good for proposals and previews.',
    badge: 'Link only',
  },
} as const;

/**
 * What hiding does not do: the page's words stay published (the public data the site reads is
 * still readable), and its form still takes submissions (/api is never gated). Shown with the
 * hidden option, and said in the guide.
 */
export const HIDDEN_NOTE =
  'Hiding is not deleting: the page’s words stay published. Unpublish it, or keep confidential details off it. A hidden Join or Contact page still takes what its form sends: to stop job applications, turn off Accepting job applications in General settings.';

/** The template note: a template hides every page it renders. */
export const TEMPLATE_NOTE = {
  service:
    'This is a template. Hiding it hides every service page at once. To hide one service, unpublish that service instead.',
  case_study:
    'This is a template. Hiding it hides every project page at once. To hide one project, unpublish that project instead.',
} as const;

/** The save landed, the edge did not take it. */
export const EDGE_MISSED = 'Saved, but the live site has not picked it up. Use Sync to edge.';
