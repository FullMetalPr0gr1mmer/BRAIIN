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
