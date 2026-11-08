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
// is a secret, so it is saved at once and no release carries it (Admin v2 R14e): a page already
// behind one asks for the new one at once; putting a page behind one, and its message, travel
// with a release.

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

/**
 * The toast after the password door in release mode on a page that already asks for a password
 * live (R14e review): the new password works at once, and only a new message waits.
 */
export function passwordLiveSaved(title: string, messageWaits: boolean): string {
  return messageWaits
    ? `${title}: the new password works now. The new message above the box goes live when it is published.`
    : `${title}: the new password works now. ${NOTHING_TO_PUBLISH}`;
}

/**
 * Release mode, the password drawer on a page that does not ask for one live (Admin v2 R14e):
 * the password is stored at once, the page asks for it once the change is published.
 */
export const RELEASE_PASSWORD_STAGED =
  'The password is saved now, but the page asks for it only once this change is published.';

/**
 * Release mode, the password drawer on a page that already asks for one live: a new password
 * works at once (a secret never waits for a release), a new message waits.
 */
export const RELEASE_PASSWORD_LIVE =
  'This page already asks for a password, so a new one works at once and everyone who typed the old one must type the new one. A new message above the box goes live when it is published.';

/**
 * A release that would put a page behind a password none was saved for (the release check, and
 * the database's own refusal of it): said where the person publishing reads the problem.
 */
export const RELEASE_PASSWORD_MISSING =
  'This page would ask for a password that was never saved. Set the password again on the Page visibility screen, then publish.';
