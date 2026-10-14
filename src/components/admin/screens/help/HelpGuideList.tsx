import type { MouseEvent } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { guideHref, readingTime, type HelpGuide } from '@/lib/admin/help/model';

// A list of guides (Admin v2 U16): the prototype's .hc-q rows, as the kit's list rows. Each
// row is a real link to the guide's page, so it works without JS and opens in a new tab with
// a modifier; in the drawer a plain click opens the guide in place (`onPick`). Rendered by
// the drawer and, on the server, by /admin/help.

export interface HelpGuideListProps {
  guides: readonly HelpGuide[];
  /** The id of the heading that names the list. */
  labelledBy: string;
  /** The drawer: open a guide in place instead of following the link. */
  onPick?: ((slug: string) => void) | undefined;
  /** The screen the help was opened on, kept on every link (guideHref). */
  screen?: string | null | undefined;
}

export default function HelpGuideList({
  guides,
  labelledBy,
  onPick,
  screen = null,
}: HelpGuideListProps) {
  function click(event: MouseEvent<HTMLAnchorElement>, slug: string) {
    if (!onPick || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onPick(slug);
  }

  return (
    <ul className="list" aria-labelledby={labelledBy}>
      {guides.map((guide) => (
        <li key={guide.slug}>
          <a
            className="li"
            href={guideHref(guide.slug, screen)}
            data-guide={guide.slug}
            onClick={(event) => click(event, guide.slug)}
          >
            <span className="li__ico" aria-hidden="true">
              <Icon name="info" />
            </span>
            <span className="li__main">
              <span className="li__t">{guide.title}</span>
              <span className="li__s">{readingTime(guide.minutes)}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
