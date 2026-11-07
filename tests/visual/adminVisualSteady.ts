/*
 * What the admin visual baselines (tests/visual/admin.visual.ts) hold steady before a picture,
 * beyond the masks: text the server writes from the clock, which a run in another part of the
 * day would change.
 *
 * The dashboard's head greets by the studio's hour ("Good morning, Amal", src/lib/admin/
 * dashboard/greeting.ts), in its <h1> (PageHead.astro) and in the breadcrumb's current item
 * (Topbar.astro). It is written on the server, so pinning the browser's clock cannot reach it,
 * and a mask would not do either: the mask is the element's box, whose width follows the word
 * ("afternoon" is wider than "morning"). So the part of the day is rewritten to one word in
 * those two places, and the picture is the same at any hour. The name after it stays.
 */

/** "Good morning", "Good afternoon" or "Good evening": every part of the day greeting() says. */
export const GREETING_SOURCE = String.raw`\bGood (?:morning|afternoon|evening)\b`;

/** The one word every run shows. */
export const STEADY_GREETING = 'Good morning';

/** Where the dashboard prints its greeting: the page head's h1 and the breadcrumb's last item. */
export const GREETING_HOLDERS = '.admin-header h1, .crumbs [aria-current="page"]';

/** The text as a picture shows it: the part of the day, whichever it is, as one word. */
export function steadyGreeting(text: string): string {
  return text.replace(new RegExp(GREETING_SOURCE, 'g'), STEADY_GREETING);
}

/*
 * Screens whose list grows with every write anywhere (Admin v2 R14d). The activity log lists
 * each sign-in, save, view and export as it happens, the visual run's own included, so between
 * the `update` run's two passes its page grew (1015 to 1271 px at 1440) and the "stable across
 * two runs" compare failed. Masking the rows was not enough: a mask is the element's box, and the
 * box follows the row count. So on these screens, and only these, the picture takes a frame that
 * no data moves:
 *   - `fixed`: the region keeps one block size (overflow clipped) and is masked: the list's card,
 *     its rows and its "1 to 25 of N" line;
 *   - `hidden`: the region is left out of the picture: the chain note while the chain links up
 *     ("The latest N entries link up", the one `ok` note), whose words follow the count and which
 *     is drawn only once there are two entries. Only that one: a broken chain's alert ("Entry N
 *     does not link to the one before it") and the export and filter notes are `err`/`warn`, and
 *     stay in the picture, so a baseline can still show them (review SEC-3).
 * Both are set through the CSSOM (style-src has no 'unsafe-inline', and the CSSOM is not an
 * inline style), after the page has loaded and before the picture. Everything above the list
 * (the head, the filters, the kind chips) is the seed's and the code's, and stays in the picture.
 */

/** One region of a framed screen: what it is, and how the frame holds it. */
export interface FrameRegion {
  selector: string;
  hold: 'fixed' | 'hidden';
  /** `fixed` only: the block size it keeps, px. */
  blockSize?: number;
}

/** The framed screens, by their path (any query: a filtered view of the same list). */
export const FRAMED: Readonly<Record<string, readonly FrameRegion[]>> = {
  '/admin/audit': [
    { selector: '.act-note[data-tone="ok"]', hold: 'hidden' },
    { selector: '.card.dt', hold: 'fixed', blockSize: 480 },
  ],
};

/** The frame a capture route's address takes, or null (every other screen is as it renders). */
export function frameFor(path: string): readonly FrameRegion[] | null {
  return FRAMED[path.split('?')[0]!] ?? null;
}
