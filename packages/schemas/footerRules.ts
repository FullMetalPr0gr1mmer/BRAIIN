// The footer's limits (Admin v2 E6), apart from the Zod schemas that use them
// (packages/schemas/admin.ts re-exports them), so the public footer (src/lib/nav/tree.ts) and
// the Footer screen's sketch read the one number without carrying the admin schemas module
// (E6 code review, CR8). SQL cannot import it: 0122's trigger keeps the literal, and
// tests/lib/footerColumns.spec.ts holds the two equal.

/** The most footer columns (heading rows) a site holds, and the most the footer draws. */
export const FOOTER_COLUMNS_MAX = 4;
