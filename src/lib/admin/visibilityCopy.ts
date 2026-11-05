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
  password: {
    title: 'Behind a password',
    text: 'Visitors type a password before the page opens. Not in the menu or search engines, and its words stay closed until someone types it.',
    badge: 'Password',
  },
} as const;

/** The password field's help, the prototype's words. */
export const PASSWORD_HINT = 'Something short you can share, on WhatsApp for example.';

/**
 * What setting a password does, said plainly: it is stored scrambled, so it cannot be read
 * back, and a new one closes the page again for everyone who typed the old one.
 */
export const PASSWORD_NOTE =
  'The password is stored scrambled, so nobody can read it back, not even you. To change it, set a new one. That also closes the page again for everyone who had typed the old one.';

/** Above the message fields, the prototype's label. */
export const PASSWORD_MESSAGE_LABEL = 'Message above the password box';

/** A page already behind a password: Apply needs the password again. */
export const PASSWORD_REQUIRED =
  'Type the password to apply. Setting it again is the only way to change the message too.';

/** The badge and the drawer need every mode, including the one the PUT route refuses. */
export type VisibilityModeKey = keyof typeof MODE_COPY;

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

// ---- release mode (Admin v2 R14b) ------------------------------------------------------------
// With releases on, a setting is staged like every other change to the live site: it waits as
// an unpublished change and goes live when it is published (releases.md §1.1, P-3). A password
// is a secret, so it stays immediate (0061's exempt `password_version`): a page already behind
// one can have it changed at once; anything else about it travels with a release.

/** The drawer's line in release mode (APPLIES_WITHIN's twin). */
export const STAGED_APPLIES = 'Goes live when it is published.';

/** The confirm in release mode (CONFIRM_SUB's twin). */
export const STAGED_CONFIRM_SUB =
  'This is saved as an unpublished change. The live site changes when it is published.';

/** The toast after a staged save. */
export function stagedSaved(title: string): string {
  return `${title}: saved as an unpublished change. It goes live when it is published.`;
}

/** After a staged save that left nothing pending: the setting is already the live one. */
export const NOTHING_TO_PUBLISH = 'There is nothing to publish.';

/** Release mode: a password is set at once, so only on a page that already asks for one. */
export const RELEASE_PASSWORD_ONLY =
  'While publishing in releases is on, a password can be changed only on a page that already asks for one, with nothing unpublished on it. To put a page behind a password, ask whoever runs the site.';

/** Release mode: changing the password keeps the message as it is. */
export const RELEASE_NOTE_KEPT =
  'While publishing in releases is on, the message above the password box stays as it is. Change only the password here.';

/** Release mode: the page has an unpublished visibility change. */
export const RELEASE_PASSWORD_PENDING =
  'This page has an unpublished change to who can see it. Publish it or discard it first.';
