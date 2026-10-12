// Paging for admin lists (Admin v2 F4b, docs/admin-v2/ui.md §2.4): one model behind the
// server Pager (links, Pager.astro) and the DataTable's (buttons, kit/DataTable.tsx), so a
// list reads "26 to 50 of 112" with the same numbered pages wherever it is.
//
// Lists are paged by the server, 25 rows at a time (the list API's `limit`/`offset`).

export const PAGE_SIZE = 25;

export interface PageInfo {
  total: number;
  limit: number;
  /** The first row's offset, clamped to a page that exists. */
  offset: number;
  /** 1-based. */
  page: number;
  pages: number;
  /** 1-based position of the first row shown, 0 when there is none. */
  from: number;
  /** 1-based position of the last row shown. */
  to: number;
}

const whole = (value: number, fallback: number) =>
  Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;

/** Where a list stands: its page, its page count and the rows it shows. */
export function pageInfo(total: number, offset: number, limit = PAGE_SIZE): PageInfo {
  const size = Math.max(1, whole(limit, PAGE_SIZE));
  const count = whole(total, 0);
  const pages = Math.max(1, Math.ceil(count / size));
  const page = Math.min(pages, Math.floor(whole(offset, 0) / size) + 1);
  const start = (page - 1) * size;
  return {
    total: count,
    limit: size,
    offset: start,
    page,
    pages,
    from: count === 0 ? 0 : start + 1,
    to: Math.min(count, start + size),
  };
}

/** "26 to 50 of 112", for the live region under a list; "No results" when it is empty. */
export function rangeText(info: PageInfo): string {
  if (info.total === 0) return 'No results';
  const n = (v: number) => v.toLocaleString('en-GB');
  return `${n(info.from)} to ${n(info.to)} of ${n(info.total)}`;
}

/** The offset of a 1-based page. */
export function offsetOf(page: number, limit = PAGE_SIZE): number {
  return Math.max(0, (Math.floor(page) - 1) * Math.max(1, limit));
}

/**
 * The page buttons to show: the first, the last, and the current page with `around` on
 * each side, with a gap where pages are skipped. A gap would hide a single page, so that
 * page is shown instead: 1 2 3 4 5 … 20, never 1 … 3 4 5 … 20 around page 4.
 */
export function pageItems(page: number, pages: number, around = 1): (number | 'gap')[] {
  const last = Math.max(1, pages);
  const current = Math.min(last, Math.max(1, page));
  const shown = new Set<number>([1, last]);
  for (let p = current - around; p <= current + around; p++) {
    if (p >= 1 && p <= last) shown.add(p);
  }
  const sorted = [...shown].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  sorted.forEach((p, i) => {
    const prev = sorted[i - 1];
    if (prev !== undefined && p - prev === 2) out.push(prev + 1);
    else if (prev !== undefined && p - prev > 2) out.push('gap');
    out.push(p);
  });
  return out;
}

/** A page number from a query parameter: a whole number from 1, else 1. */
export function pageParam(value: string | null | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}
