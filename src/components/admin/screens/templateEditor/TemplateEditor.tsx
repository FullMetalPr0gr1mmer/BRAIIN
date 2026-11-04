import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArabicGapsProvider,
  ArabicMissingBar,
  EditorLanguageProvider,
  EditorLanguageSwitch,
  useEditorLanguage,
} from '@/components/admin/fields/editorLanguage';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import Segmented from '@/components/admin/kit/Segmented';
import StatusBadge, { Badge } from '@/components/admin/kit/StatusBadge';
import {
  NOT_PREVIEWED,
  PREVIEW_HEADING,
  PREVIEW_LOADING,
  VIEW_LABEL,
  VIEW_OPTIONS,
  previewLangAfter,
  previewLead,
  viewAfterPreviewPick,
  type EditorView,
  type PreviewLang,
} from '@/components/admin/screens/pagePreview/editorSide';
import { mayLeave } from '@/components/admin/screens/pageEditor/flows';
import { confirmDialog } from '@/lib/admin/confirm';
import { onDraftsMoved } from '@/lib/admin/releaseEvents';
import type { EntitySave } from '@/lib/admin/useEntitySave';
import { localizedPath } from '@/lib/i18n';
import { TEMPLATE_PARTS } from '@/lib/templates/parts';
import ItemPanel from './ItemPanel';
import PartsColumn from './PartsColumn';
import SharedPanel from './SharedPanel';
import {
  NOUN,
  addressWithItem,
  fullEditorHref,
  itemsOf,
  unpublishedNote,
  type TemplatePanel,
} from './model';
import type { TemplateEditorSetup } from './types';

// The live preview column (Admin v2 E2): its own lazy chunk (`admin-page-preview`), loaded only
// once the preview is on screen, so a narrow screen that never opens it never downloads it or
// asks the Worker for a preview (P-15).
const PreviewColumn = lazy(() => import('@/components/admin/screens/pagePreview/PreviewColumn'));

/** The width from which the editor shows its three columns (ui.md "Responsive"). */
const THREE_COLUMNS = '(min-width: 1280px)';

// A template editor (Admin v2 E3, docs/admin-v2/ui.md "Template editors (AV-31)"; the
// prototype's template pages): the AdminTemplateEditor island at /admin/pages/template/service
// and /project. The server page decides who may open it and hands over the items, the one to
// show, the built-in shared text and the role's access (src/lib/admin/pages/templates.ts);
// everything else is read here, through the resource and singleton routes, which lay pending
// changes over live while releases are on. It is laid out as the page editor (E1), whose
// stylesheet it shares:
//
//   the bar        All pages, the Template badge and the item's status, Showing (the picker:
//                  services grouped by discipline in <optgroup>s, projects one flat list),
//                  English / العربية / Both for every field and "Arabic missing: N" (the
//                  screen's: both panels' forms read it), Full editor (the item's own), Open
//                  page in English and Arabic.
//   the parts      what this screen edits ("This service" / "This project", "Shared text"),
//                  then the template's fixed parts in the page's order (PartsColumn).
//   the fields     the item's own words (ItemPanel: the full editor's save) or the shared
//                  text (SharedPanel: the template_copy singleton).
//   the preview    E2's preview column at the item's page, reloaded after each save here, and
//                  moved to the part picked in the parts column.
//
// Switching the item or the panel with unsaved work asks first while releases are off (each
// save is explicit, P-5); with them on the change is saved on the way (mayLeave, E1's rule).
// Every button is the person's convenience: each route checks the capability again.

export default function TemplateEditor(props: TemplateEditorSetup) {
  return (
    <EditorLanguageProvider>
      <ArabicGapsProvider>
        <Editor {...props} />
      </ArabicGapsProvider>
    </EditorLanguageProvider>
  );
}

function Editor({ kind, groups, selected, builtIn, access }: TemplateEditorSetup) {
  const noun = NOUN[kind];
  const items = useMemo(() => itemsOf(groups), [groups]);
  const [itemId, setItemId] = useState<string | null>(selected);
  const item = items.find((i) => i.id === itemId) ?? null;
  const panels = useMemo<TemplatePanel[]>(
    () => [
      ...(access.item ? ['item' as const] : []),
      ...(access.shared ? ['shared' as const] : []),
    ],
    [access.item, access.shared],
  );
  const [panel, setPanel] = useState<TemplatePanel>(panels[0] ?? 'shared');
  const [part, setPart] = useState('');
  const form = useRef<EntitySave | null>(null);
  const pickerId = useId();

  // The live preview (E2): a counter every save here moves (the preview reloads once per
  // burst), the preview's language (the editor's; Both keeps the last one), the narrow screens'
  // Edit | Preview choice, and whether the screen is wide enough for three columns (read after
  // hydration, so the server and the first render agree).
  const [revision, setRevision] = useState(0);
  const { lang } = useEditorLanguage();
  const [previewLang, setPreviewLang] = useState<PreviewLang>('en');
  useEffect(() => setPreviewLang((current) => previewLangAfter(lang, current)), [lang]);
  const [view, setView] = useState<EditorView>('edit');
  const [wide, setWide] = useState<boolean | null>(null);
  useEffect(() => {
    const query = window.matchMedia(THREE_COLUMNS);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  // Each form says when a save of it landed (the preview reloads once per burst) and whether
  // it saves pending changes, which the preview's lead says (useSaveSignal).
  const saved = useCallback(() => setRevision((n) => n + 1), []);
  const [release, setRelease] = useState(false);

  // Releases on: a pending change settled or thrown away in the publish dialog or the savebar
  // moved what the preview lays over the page, so it reloads.
  useEffect(() => onDraftsMoved(() => setRevision((n) => n + 1)), []);

  // The address follows the item, so a reload or a link opens it again.
  useEffect(() => {
    if (!itemId) return;
    const next = addressWithItem(window.location.href, itemId);
    if (next !== window.location.href) window.history.replaceState(window.history.state, '', next);
  }, [itemId]);

  /** Whether the open form may be left; unsaved work is never dropped silently. */
  const leaveOpen = () => mayLeave(form.current, confirmDialog);

  async function chooseItem(next: string) {
    if (next === itemId) return;
    // The shared text is every item's: its form stays open across items. The item's own form
    // is left, so it asks first.
    if (panel === 'item' && !(await leaveOpen())) return;
    setItemId(next);
  }

  async function choosePanel(next: TemplatePanel) {
    if (next === panel) return;
    if (!(await leaveOpen())) return;
    setPanel(next);
  }

  /** A part picked in the preview: it is the one shown; below 1280 px the fields come back. */
  function pickFromPreview(id: string) {
    setPart(id);
    setView((current) => viewAfterPreviewPick(current, wide));
  }

  const parts = TEMPLATE_PARTS[kind];
  const previewSections = useMemo(
    () => parts.flatMap((p) => (p.id === null ? [] : [{ id: p.id, name: p.name, visible: true }])),
    [parts],
  );
  const hasPreview = item !== null && item.previewable;
  const onScreen = hasPreview && wide !== null && (wide || view === 'preview');
  const [previewMounted, setPreviewMounted] = useState(false);
  useEffect(() => {
    if (onScreen) setPreviewMounted(true);
  }, [onScreen]);

  const draftNote = item ? unpublishedNote(kind, item.status) : null;

  return (
    <div className="pe tpl">
      <div className="pe__bar" role="group" aria-label={`The ${noun} page template`}>
        <a className="btn" data-size="sm" data-variant="ghost" href="/admin/pages">
          <Icon name="back" size={15} />
          All pages
        </a>
        <div className="pe__badges">
          <Badge tone="sky">Template</Badge>
          {item && <StatusBadge status={item.status} />}
        </div>
        {items.length > 0 && (
          <div className="tpl__pick">
            <label htmlFor={pickerId}>Showing</label>
            <select
              id={pickerId}
              value={itemId ?? ''}
              onChange={(e) => void chooseItem(e.target.value)}
            >
              {groups.map((group) =>
                group.label === null ? (
                  group.items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.title.en}
                    </option>
                  ))
                ) : (
                  <optgroup key={group.label} label={group.label}>
                    {group.items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.title.en}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
            </select>
          </div>
        )}
        <div className="pe__lang">
          <EditorLanguageSwitch />
          <ArabicMissingBar />
        </div>
        {item && (
          <div className="pe__acts">
            <a className="btn" data-size="sm" href={fullEditorHref(kind, item.id)}>
              <Icon name="edit" size={15} />
              Full editor
            </a>
            {item.status === 'published' && (
              <>
                <a className="btn" data-size="sm" href={item.path} target="_blank" rel="noopener">
                  <Icon name="ext" size={15} />
                  Open page
                </a>
                <a
                  className="btn"
                  data-size="sm"
                  href={localizedPath(item.path, 'ar')}
                  target="_blank"
                  rel="noopener"
                  aria-label="Open page in Arabic"
                >
                  <Icon name="ext" size={15} />
                  <span lang="ar">العربية</span>
                </a>
              </>
            )}
          </div>
        )}
      </div>

      {!item ? (
        <Note tone="info">
          {kind === 'service'
            ? 'There is no service to show yet. Add one in Services, then come back to edit its page here.'
            : 'There is no project to show yet. Add one in Projects, then come back to edit its page here.'}
        </Note>
      ) : (
        <div className="pe__cols" data-view={hasPreview ? view : undefined}>
          {hasPreview && (
            <div className="pe__view">
              <Segmented<EditorView>
                label={VIEW_LABEL}
                value={view}
                onChange={setView}
                options={VIEW_OPTIONS}
              />
            </div>
          )}
          <PartsColumn
            noun={noun}
            parts={parts}
            panel={panel}
            part={part}
            panels={panels}
            onPanel={(next) => void choosePanel(next)}
            onPart={setPart}
          />
          <div className="pe__fields">
            {panel === 'item' && access.item ? (
              <ItemPanel
                key={item.id}
                kind={kind}
                item={item}
                write={access.item}
                formRef={form}
                onSaved={saved}
                onMode={setRelease}
              />
            ) : (
              <SharedPanel
                kind={kind}
                builtIn={builtIn}
                path={item.status === 'published' ? item.path : null}
                formRef={form}
                onSaved={saved}
                onMode={setRelease}
              />
            )}
          </div>
          <section className="pe__preview" aria-labelledby="tpl-preview-h">
            <div className="pe__preview-h">
              <h2 id="tpl-preview-h" className="pe__h">
                {PREVIEW_HEADING}
              </h2>
              <p className="pe__tiny">{previewLead(release)}</p>
            </div>
            {draftNote && <Note>{draftNote}</Note>}
            {!hasPreview ? (
              <Note>{NOT_PREVIEWED}</Note>
            ) : previewMounted ? (
              <Suspense
                fallback={
                  <p className="pv-col__loading" role="status">
                    {PREVIEW_LOADING}
                  </p>
                }
              >
                <PreviewColumn
                  key={item.id}
                  path={item.path}
                  title={item.title.en}
                  lang={previewLang}
                  onLang={setPreviewLang}
                  selected={part}
                  sections={previewSections}
                  revision={revision}
                  onSelect={pickFromPreview}
                />
              </Suspense>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
