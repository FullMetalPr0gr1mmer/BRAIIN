import { offsetOf, pageItems, type PageInfo } from '@/lib/admin/pager';

// A pager inside islands (Admin v2 F4b): ui/Pager.astro's model with buttons instead of
// links, for a list paged by the server through an API call. Previous, the numbered pages
// (the current one aria-current="page", a gap where pages are skipped), Next. Nothing
// renders for a list that fits on one page.

export interface PagerProps {
  info: PageInfo;
  onPage: (offset: number) => void;
  label?: string;
}

export default function Pager({ info, onPage, label = 'Pages' }: PagerProps) {
  if (info.pages <= 1) return null;
  const go = (page: number) => onPage(offsetOf(page, info.limit));
  return (
    <nav className="pager" aria-label={label}>
      <ul>
        <li>
          <button type="button" disabled={info.page <= 1} onClick={() => go(info.page - 1)}>
            Previous
          </button>
        </li>
        {pageItems(info.page, info.pages).map((item, index) => (
          <li key={item === 'gap' ? `gap-${index}` : item}>
            {item === 'gap' ? (
              <span className="pager__gap" aria-hidden="true">
                …
              </span>
            ) : (
              <button
                type="button"
                aria-label={`Page ${item}`}
                aria-current={item === info.page ? 'page' : undefined}
                onClick={() => go(item)}
              >
                {item}
              </button>
            )}
          </li>
        ))}
        <li>
          <button
            type="button"
            disabled={info.page >= info.pages}
            onClick={() => go(info.page + 1)}
          >
            Next
          </button>
        </li>
      </ul>
    </nav>
  );
}
