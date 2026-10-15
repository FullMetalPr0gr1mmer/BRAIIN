import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Segmented from '@/components/admin/kit/Segmented';
import type { EditorLanguage } from '@/lib/admin/uiSchema';
import { revealAndFocus, useRevealListener } from './reveal';

// The language an editor shows its bilingual fields in (Admin v2 F5a, ui.md §2.6):
//   EditorLanguageProvider  English, Arabic or Both for the whole form. Both lays the two
//                           halves side by side for translators (one column below 32rem
//                           of the field's width, admin.css). Remembered per browser
//                           (`admin:editLang`, D6), never sent anywhere; every storage
//                           access is guarded, so a private window simply starts in English.
//   useFieldLanguage        one field's own EN | AR choice on top of it; the editor-wide
//                           switch resets every field's choice.
//   ArabicGapsProvider      which required Arabic halves are empty (useArabicGap), for the
//                           "Arabic missing: N" bar and its "Next gap" (ArabicMissingBar).
// Both inputs of a pair stay in the DOM, the other one `hidden`, so an error or a gap in
// it can be linked to: revealField (./reveal.ts) shows it first.

const STORAGE_KEY = 'admin:editLang';
const LANGUAGES: readonly EditorLanguage[] = ['en', 'ar', 'both'];

interface LanguageContextValue {
  lang: EditorLanguage;
  setLang: (lang: EditorLanguage) => void;
}

const LanguageContext = createContext<LanguageContextValue>({
  lang: 'en',
  setLang: () => undefined,
});

function stored(): EditorLanguage | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.includes(value as EditorLanguage) ? (value as EditorLanguage) : null;
  } catch {
    return null;
  }
}

export function EditorLanguageProvider({
  initial,
  children,
}: {
  initial?: EditorLanguage | undefined;
  children: ReactNode;
}) {
  // English on the server and in the first client render (the same markup), then the
  // browser's remembered choice.
  const [lang, setLangState] = useState<EditorLanguage>(initial ?? 'en');
  useEffect(() => {
    if (initial) return;
    const remembered = stored();
    if (remembered) setLangState(remembered);
  }, [initial]);
  const setLang = useCallback((next: EditorLanguage) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage refused (a private window, blocked site data): the choice lasts the page.
    }
  }, []);
  const value = useMemo(() => ({ lang, setLang }), [lang, setLang]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useEditorLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}

/** The editor-wide switch: English, العربية or Both. */
export function EditorLanguageSwitch() {
  const { lang, setLang } = useEditorLanguage();
  return (
    <Segmented<EditorLanguage>
      label="Editing language"
      value={lang}
      onChange={setLang}
      options={[
        { value: 'en', label: 'English' },
        { value: 'ar', label: 'العربية', lang: 'ar' },
        { value: 'both', label: 'Both' },
      ]}
    />
  );
}

/**
 * Which half of one bilingual field shows: the editor's language unless the field's own
 * EN | AR switch chose otherwise (reset whenever the editor-wide language changes), both
 * in Both. A reveal request for a hidden half shows it.
 */
export function useFieldLanguage(ids: { en: string; ar: string }): {
  shown: EditorLanguage;
  choose: (lang: 'en' | 'ar') => void;
} {
  const { lang } = useEditorLanguage();
  const [local, setLocal] = useState<'en' | 'ar' | null>(null);
  const [previous, setPrevious] = useState(lang);
  if (previous !== lang) {
    // Adjusting state while rendering (React's pattern for "reset when a value changes"):
    // no effect, so the field never paints once in its old language.
    setPrevious(lang);
    setLocal(null);
  }
  const shown: EditorLanguage = lang === 'both' ? 'both' : (local ?? lang);
  useRevealListener((id) => {
    if (shown === 'both') return;
    const names = (half: string) => id === half || id.startsWith(`${half}-`);
    if (names(ids.ar) && shown === 'en') setLocal('ar');
    else if (names(ids.en) && shown === 'ar') setLocal('en');
  });
  return { shown, choose: setLocal };
}

// ---- Arabic gaps ----------------------------------------------------------------------

const GapReportContext = createContext<((id: string, missing: boolean) => void) | null>(null);
const GapListContext = createContext<ReadonlySet<string>>(new Set());

export function ArabicGapsProvider({ children }: { children: ReactNode }) {
  const [gaps, setGaps] = useState<ReadonlySet<string>>(() => new Set());
  // Stable, and in its own context, so a field reporting a gap does not re-render the rest.
  const report = useCallback((id: string, missing: boolean) => {
    setGaps((current) => {
      if (current.has(id) === missing) return current;
      const next = new Set(current);
      if (missing) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  return (
    <GapReportContext.Provider value={report}>
      <GapListContext.Provider value={gaps}>{children}</GapListContext.Provider>
    </GapReportContext.Provider>
  );
}

/** Reports whether the Arabic input `id` is a gap (required and empty) while mounted. */
export function useArabicGap(id: string, missing: boolean): void {
  const report = useContext(GapReportContext);
  useEffect(() => {
    report?.(id, missing);
  }, [report, id, missing]);
  useEffect(() => () => report?.(id, false), [report, id]);
}

/** The gaps in the order they appear on the form. */
function inDocumentOrder(ids: Iterable<string>): HTMLElement[] {
  return [...ids]
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null)
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

/** "Arabic missing: 2" and "Next gap", which shows and focuses each gap in turn. */
export function ArabicMissingBar() {
  const gaps = useContext(GapListContext);
  const last = useRef<string | null>(null);
  const count = gaps.size;

  function next() {
    const ordered = inDocumentOrder(gaps);
    if (ordered.length === 0) return;
    const active = document.activeElement;
    const from =
      active instanceof HTMLElement && gaps.has(active.id)
        ? active
        : last.current
          ? document.getElementById(last.current)
          : null;
    const after = from
      ? ordered.find((el) => from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      : undefined;
    const target = after ?? ordered[0];
    if (!target) return;
    last.current = target.id;
    revealAndFocus(target.id);
  }

  return (
    <div className="ar-gaps" data-count={count}>
      <p className="ar-gaps__n" role="status">
        {count > 0 ? `Arabic missing: ${count}` : ''}
      </p>
      {count > 0 && (
        <button type="button" data-variant="ghost" onClick={next}>
          Next gap
        </button>
      )}
    </div>
  );
}
