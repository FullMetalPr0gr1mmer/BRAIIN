import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { AdminApiError, adminFetch } from '@/lib/admin/client';
import {
  MIN_QUERY,
  cleanHelpQuery,
  relatedTo,
  screenOf,
  type HelpArticle,
  type HelpGuide,
  type HelpIndex,
  type HelpLang,
} from '@/lib/admin/help/model';
import ChromeDrawer, { useOpenOn } from '../chrome/ChromeDrawer';
import HelpArticleBody from './HelpArticleBody';
import HelpGuideList from './HelpGuideList';

// The help centre's drawer (Admin v2 U16), the prototype's helpCentre(): opened from the
// topbar's "?" (a link to /admin/help without JS) on every admin page. A search box, the
// guides for the screen it was opened on, then every guide the role may read; a guide opens
// in place with "All guides" to go back, its Arabic text a click away, and related guides
// below it.
//
// What the server sends is already the role's: the list and the search are filtered from
// ROLE_CAPS on the server (src/lib/admin/help), so nothing here decides who sees what. The
// list is asked for the first time the drawer opens, never on a timer (P-15); a search
// waits for a pause in typing, and a newer one cancels an older one still in flight.
//
// Focus: the search box when the drawer opens, a guide's title when it opens (so a screen
// reader starts there), and back to the row it came from on "All guides". The status line
// is a live region: loading, how many guides match, what could not be read.

const DEBOUNCE_MS = 250;

export default function HelpDrawer() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const articles = useRef(new Map<string, HelpArticle>());
  const cameFrom = useRef<string | null>(null);

  const [index, setIndex] = useState<HelpIndex | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HelpGuide[] | null>(null);
  const [article, setArticle] = useState<HelpArticle | null>(null);
  const [lang, setLang] = useState<HelpLang>('en');
  // The live line: what is loading or could not be read, else how many guides match.
  const [status, setStatus] = useState('');
  const [matches, setMatches] = useState('');
  // Moves focus once the view it targets has rendered.
  const [focusTo, setFocusTo] = useState<'title' | 'back' | null>(null);

  const loadIndex = useCallback(async () => {
    setStatus('Loading…');
    const screen = screenOf(window.location.pathname) ?? '/admin';
    try {
      setIndex(await adminFetch<HelpIndex>(`/api/admin/help?screen=${encodeURIComponent(screen)}`));
      setStatus('');
    } catch {
      setStatus('The guides could not be loaded just now.');
    }
  }, []);

  const open = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    inFlight.current?.abort();
    setQuery('');
    setResults(null);
    setArticle(null);
    setStatus('');
    setMatches('');
    dialog.showModal();
    searchRef.current?.focus();
    if (!index) void loadIndex();
  }, [index, loadIndex]);
  const openerRef = useOpenOn('help', open);

  /** Searches for an already cleaned query of at least MIN_QUERY characters. */
  const search = useCallback(async (q: string) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const data = await adminFetch<{ results: HelpGuide[] }>(
        `/api/admin/help/search?q=${encodeURIComponent(q)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setResults(data.results);
      setStatus('');
      setMatches(
        data.results.length === 0
          ? 'No guide matches that. Try other words.'
          : `${data.results.length} ${data.results.length === 1 ? 'guide matches' : 'guides match'}.`,
      );
    } catch {
      if (!controller.signal.aborted) setStatus('The guides could not be searched just now.');
    }
  }, []);

  // A search runs once typing pauses; Enter runs it at once (`submit`). Fewer than two
  // characters search nothing: the lists come back.
  useEffect(() => {
    const q = cleanHelpQuery(query);
    if (q.length < MIN_QUERY) {
      inFlight.current?.abort();
      setResults(null);
      setMatches('');
      return;
    }
    const timer = window.setTimeout(() => void search(q), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, search]);

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    const q = cleanHelpQuery(query);
    if (q.length >= MIN_QUERY) void search(q);
  }

  const openGuide = useCallback(async (slug: string) => {
    cameFrom.current = slug;
    const cached = articles.current.get(slug);
    if (cached) {
      setArticle(cached);
      setLang('en');
      setFocusTo('title');
      return;
    }
    setStatus('Loading…');
    try {
      const data = await adminFetch<{ article: HelpArticle }>(
        `/api/admin/help/article?slug=${encodeURIComponent(slug)}`,
      );
      articles.current.set(slug, data.article);
      setArticle(data.article);
      setLang('en');
      setStatus('');
      setFocusTo('title');
    } catch (err) {
      setStatus(
        err instanceof AdminApiError && err.info.status === 404
          ? 'That guide is not available.'
          : 'That guide could not be loaded just now.',
      );
    }
  }, []);

  function back() {
    setArticle(null);
    setFocusTo('back');
  }

  useEffect(() => {
    if (focusTo === 'title') {
      titleRef.current?.focus();
      bodyRef.current?.closest('.drw__b')?.scrollTo({ top: 0 });
    } else if (focusTo === 'back') {
      const row = cameFrom.current
        ? bodyRef.current?.querySelector<HTMLElement>(`[data-guide="${cameFrom.current}"]`)
        : null;
      (row ?? searchRef.current)?.focus();
    }
    if (focusTo) setFocusTo(null);
  }, [focusTo]);

  const guides = index?.guides ?? [];
  const onScreen = guides.filter((guide) => index?.onScreen.includes(guide.slug));
  const ar = lang === 'ar';

  return (
    <ChromeDrawer
      dialogRef={dialogRef}
      openerRef={openerRef}
      titleId="help-title"
      title="Help centre"
    >
      <div className="hc" ref={bodyRef}>
        <p className="hc__sub">Short guides, written for people, not developers.</p>
        <form role="search" className="hc__search" onSubmit={submit}>
          <label htmlFor="help-q" className="visually-hidden">
            Search the guides
          </label>
          <input
            ref={searchRef}
            id="help-q"
            type="search"
            value={query}
            placeholder="Search the guides…"
            autoComplete="off"
            maxLength={64}
            onChange={(event) => {
              setQuery(event.target.value);
              if (article) setArticle(null);
            }}
          />
        </form>
        <p className="drw__status" role="status">
          {status || matches}
        </p>

        {article ? (
          <article className="hc-view" aria-labelledby="help-article-title">
            <p className="hc-view__bar">
              <button type="button" data-variant="ghost" data-size="sm" onClick={back}>
                <Icon name="back" size={14} />
                All guides
              </button>
              <button
                type="button"
                data-variant="soft"
                data-size="sm"
                lang={ar ? 'en' : 'ar'}
                onClick={() => setLang(ar ? 'en' : 'ar')}
              >
                {ar ? 'Read in English' : 'اقرأ بالعربية'}
              </button>
            </p>
            <h3
              id="help-article-title"
              ref={titleRef}
              tabIndex={-1}
              className="hc__title"
              lang={lang}
              dir={ar ? 'rtl' : 'ltr'}
            >
              {ar ? article.titleAr : article.title}
            </h3>
            <HelpArticleBody
              article={article}
              lang={lang}
              level={4}
              related={relatedTo(article, guides)}
              onPick={(slug) => void openGuide(slug)}
            />
          </article>
        ) : results !== null ? (
          results.length > 0 && (
            <section aria-labelledby="help-results-h">
              <h3 id="help-results-h" className="hc__h">
                Results
              </h3>
              <HelpGuideList
                guides={results}
                labelledBy="help-results-h"
                onPick={(slug) => void openGuide(slug)}
              />
            </section>
          )
        ) : (
          index && (
            <>
              {onScreen.length > 0 && (
                <section aria-labelledby="help-screen-h">
                  <h3 id="help-screen-h" className="hc__h">
                    On this screen
                  </h3>
                  <HelpGuideList
                    guides={onScreen}
                    labelledBy="help-screen-h"
                    onPick={(slug) => void openGuide(slug)}
                  />
                </section>
              )}
              <section aria-labelledby="help-all-h">
                <h3 id="help-all-h" className="hc__h">
                  All guides
                </h3>
                <HelpGuideList
                  guides={guides}
                  labelledBy="help-all-h"
                  onPick={(slug) => void openGuide(slug)}
                />
              </section>
            </>
          )
        )}
      </div>
    </ChromeDrawer>
  );
}
