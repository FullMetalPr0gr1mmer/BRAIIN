import Icon from '@/components/admin/kit/Icon';
import type { HelpBlock } from '@schemas/help';
import {
  readingTime,
  type HelpArticle,
  type HelpGuide,
  type HelpLang,
} from '@/lib/admin/help/model';
import HelpGuideList from './HelpGuideList';

// One guide's reading time, tags, text and related guides (Admin v2 U16), shared by the
// drawer and /admin/help. Every text is a React text node, so nothing in a guide is ever
// read as markup (the table refuses `<` and `>` as well, migration 0046). The text is in
// the language asked for, marked with its `lang` and `dir`; the badges and labels around it
// are the admin's, in English.
//
// Heading levels follow where it sits: in the drawer under the dialog's h2 and the guide's
// h3 (blocks h4), on the page under the page's h1 (blocks h2).

export interface HelpArticleBodyProps {
  article: HelpArticle;
  lang: HelpLang;
  /** The level of a heading inside the guide. */
  level: 2 | 4;
  /** Other guides to read next, already filtered to the ones the role may read. */
  related: readonly HelpGuide[];
  onPick?: ((slug: string) => void) | undefined;
  /** The screen the help was opened on, kept on the related guides' links. */
  screen?: string | null | undefined;
}

const TIP: Record<HelpLang, string> = { en: 'Tip: ', ar: 'نصيحة: ' };

function Blocks({
  blocks,
  level,
  lang,
}: {
  blocks: readonly HelpBlock[];
  level: 2 | 4;
  lang: HelpLang;
}) {
  const Heading = level === 2 ? 'h2' : 'h4';
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.t) {
          case 'p':
            return <p key={i}>{block.x}</p>;
          case 'h':
            return <Heading key={i}>{block.x}</Heading>;
          case 'ol':
            return (
              <ol key={i}>
                {block.x.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ol>
            );
          case 'tip':
            return (
              <p key={i} className="hc-tip">
                <Icon name="sparkle" size={16} />
                <span>
                  <span className="visually-hidden">{TIP[lang]}</span>
                  {block.x}
                </span>
              </p>
            );
        }
      })}
    </>
  );
}

export default function HelpArticleBody({
  article,
  lang,
  level,
  related,
  onPick,
  screen = null,
}: HelpArticleBodyProps) {
  const RelatedHeading = level === 2 ? 'h2' : 'h4';
  const relatedId = `help-related-${level}`;
  return (
    <>
      <p className="hc-meta">
        <span className="badge" data-tone="gray" data-plain="">
          {readingTime(article.minutes)}
        </span>
        {article.tags.map((tag) => (
          <span key={tag} className="badge" data-tone="klein" data-plain="">
            {tag}
          </span>
        ))}
      </p>
      <div className="hc-art" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <Blocks blocks={article.body[lang]} level={level} lang={lang} />
      </div>
      {related.length > 0 && (
        <section className="hc-related" aria-labelledby={relatedId}>
          <RelatedHeading id={relatedId} className="hc__h">
            Related
          </RelatedHeading>
          <HelpGuideList guides={related} labelledBy={relatedId} onPick={onPick} screen={screen} />
        </section>
      )}
    </>
  );
}
