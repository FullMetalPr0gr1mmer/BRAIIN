import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import Segmented from '@/components/admin/kit/Segmented';
import {
  createPreviewChannel,
  type ChannelHost,
  type PreviewChannel,
} from '@/lib/admin/previewChannel';
import { PREVIEW_MESSAGE_VERSION } from '@schemas/previewMessage';
import {
  DEVICE_OPTIONS,
  READY_GRACE_MS,
  RELOAD_DELAY_MS,
  fitFrame,
  followUp,
  mayOpen,
  missingNote,
  previewSrc,
  showsPage,
  type PreviewDevice,
  type PreviewLang,
} from './model';
import { PREVIEW_LOADING } from './editorSide';

// The page editor's live preview column (Admin v2 E2, docs/admin-v2/ui.md "Preview column
// (AV-26)"), loaded through import() only once the preview is on screen (the lazy
// `admin-page-preview` chunk). It frames R9's preview route (`/admin/preview/**`): with
// releases off that is the live page, with them on the person's pending changes laid over
// it. It writes nothing.
//
//   the frame    the page at a device's width (Desktop 1280, Tablet 834, Phone 390), scaled
//                into the column through the CSSOM after hydration (CSP: no style attribute);
//                the language follows the editor's (Both keeps the one shown) and has its own
//                switch here; Reload preview.
//   the bridge   R9's parent half (src/lib/admin/previewChannel.ts): posts to the frame's
//                window with this origin as the targetOrigin, takes a message only from this
//                origin AND that window, parsed as the envelope (packages/schemas/
//                previewMessage.ts). On `ready` it jumps to the open section and outlines it;
//                after a save the editor reports (`revision`) it sends `reload` once, and jumps
//                back on the next `ready`; a click in a section (`select`) opens that section
//                through the editor's own select (which asks about unsaved work first).

export interface PreviewSection {
  id: string;
  name: string;
  visible: boolean;
}

export interface PreviewColumnProps {
  /** The page's English public path (`/about`). */
  path: string;
  /** The page's English title, for the frame's name. */
  title: string;
  lang: PreviewLang;
  onLang: (lang: PreviewLang) => void;
  /** The open section's id (or the editor's "page details" key). */
  selected: string;
  /** The sections the editor lists, in order. */
  sections: readonly PreviewSection[];
  /** Moves after every save the editor makes: the preview reloads once per burst. */
  revision: number;
  onSelect: (sectionId: string) => void;
}

type FrameState = 'loading' | 'ready' | 'failed';

/** Whether the column is laid out (not inside a `display: none` box). */
const isShown = (el: HTMLElement | null) => el !== null && el.getClientRects().length > 0;

export default function PreviewColumn({
  path,
  title,
  lang,
  onLang,
  selected,
  sections,
  revision,
  onSelect,
}: PreviewColumnProps) {
  const src = previewSrc(path, lang) ?? '';
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const channel = useRef<PreviewChannel | null>(null);
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  // A new key mounts a new frame: Reload when the bridge does not answer, and Back.
  const [frameKey, setFrameKey] = useState(0);
  const [state, setState] = useState<FrameState>('loading');
  // What the preview last said it shows: its path and the sections it marks.
  const [shown, setShown] = useState<{ path: string; listed: readonly string[] } | null>(null);

  // The latest props and state for the channel's listener and the timers, which outlive a
  // render.
  const latest = useRef({ src, selected, sections, onSelect, state });
  latest.current = { src, selected, sections, onSelect, state };
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const loads = useRef(0);

  // The channel lives as long as the column; it reads the frame's window when it posts or
  // checks a message's source, so a remounted frame needs no new channel.
  useEffect(() => {
    const frame = {
      get contentWindow() {
        return frameRef.current?.contentWindow ?? null;
      },
    };
    const opened = createPreviewChannel(frame, window as unknown as ChannelHost, (message) => {
      const now = latest.current;
      switch (message.type) {
        case 'ready':
          setShown({ path: message.path, listed: message.sections.map((s) => s.id) });
          setState('ready');
          return;
        case 'navigate':
          setState('loading');
          return;
        case 'select': {
          const onPage = showsPage(shownRef.current?.path ?? '', now.src);
          const ids = now.sections.map((s) => s.id);
          if (mayOpen(message.sectionId, ids, now.selected, onPage))
            now.onSelect(message.sectionId);
          return;
        }
        case 'scroll':
          return;
      }
    });
    channel.current = opened;
    return () => {
      opened.close();
      channel.current = null;
    };
  }, []);
  // A new address (the language) loads a new page.
  useEffect(() => {
    setState('loading');
    setShown(null);
  }, [src, frameKey]);

  const onPage = shown !== null && showsPage(shown.path, src);

  // On `ready`, and whenever another section opens: jump to it and outline it.
  useEffect(() => {
    if (state !== 'ready' || !shown) return;
    for (const message of followUp(shown.listed, selected, onPage)) channel.current?.send(message);
  }, [state, shown, selected, onPage]);

  // After a save: reload once the burst settles. Without the bridge, a new frame. While the
  // column is hidden (the fields shown on a narrow screen) the reload waits until it is shown
  // again, so a save does not ask the Worker for a preview nobody sees (P-15).
  const firstRevision = useRef(revision);
  const stale = useRef(false);
  useEffect(() => {
    if (revision === firstRevision.current) return;
    const timer = window.setTimeout(() => {
      if (isShown(areaRef.current)) reload();
      else stale.current = true;
    }, RELOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [revision]);

  function reload() {
    const sent =
      latest.current.state === 'ready' &&
      (channel.current?.send({ v: PREVIEW_MESSAGE_VERSION, type: 'reload' }) ?? false);
    setState('loading');
    if (!sent) setFrameKey((key) => key + 1);
  }

  // The frame loaded: if the bridge has not said `ready` shortly after, the page shown has no
  // bridge (an error page, another site).
  function loaded() {
    const load = ++loads.current;
    window.setTimeout(() => {
      if (load === loads.current && latest.current.state === 'loading') setState('failed');
    }, READY_GRACE_MS);
  }

  // The page's width scaled into the column (CSSOM after hydration: the CSP has no
  // 'unsafe-inline', so no style attribute is ever drawn).
  useLayoutEffect(() => {
    const area = areaRef.current;
    const box = boxRef.current;
    const frame = frameRef.current;
    if (!area || !box || !frame) return;
    const apply = () => {
      if (stale.current && isShown(area)) {
        stale.current = false;
        reload();
      }
      const fit = fitFrame({ width: area.clientWidth, height: area.clientHeight }, device);
      box.style.width = `${fit.boxWidth}px`;
      box.style.height = `${fit.boxHeight}px`;
      frame.style.width = `${fit.frameWidth}px`;
      frame.style.height = `${fit.frameHeight}px`;
      frame.style.transform = `scale(${fit.scale})`;
    };
    apply();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(apply);
    observer.observe(area);
    return () => observer.disconnect();
  }, [device, frameKey]);

  const open = useMemo(
    () => sections.find((section) => section.id === selected) ?? null,
    [sections, selected],
  );
  const note =
    state === 'ready' && onPage && shown ? missingNote(open, shown.listed, selected) : null;

  return (
    <div className="pv-col">
      <div className="pv-col__bar">
        <Segmented<PreviewDevice>
          label="Preview size"
          value={device}
          onChange={setDevice}
          options={DEVICE_OPTIONS}
        />
        <Segmented<PreviewLang>
          label="Preview language"
          value={lang}
          onChange={onLang}
          options={[
            { value: 'en', label: 'English' },
            { value: 'ar', label: 'العربية', lang: 'ar' },
          ]}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label="Reload the preview"
          title="Reload the preview"
          onClick={() => reload()}
        >
          <Icon name="refresh" size={15} />
        </button>
      </div>
      {state === 'ready' && !onPage && (
        <Note role="status" className="pv-col__note">
          The preview shows another page.{' '}
          <button
            type="button"
            className="btn"
            data-size="sm"
            onClick={() => setFrameKey((key) => key + 1)}
          >
            Back to {title}
          </button>
        </Note>
      )}
      {state === 'failed' && (
        <Note role="alert" tone="warn" className="pv-col__note">
          The preview could not show this page.{' '}
          <button
            type="button"
            className="btn"
            data-size="sm"
            onClick={() => setFrameKey((key) => key + 1)}
          >
            Show {title} again
          </button>
        </Note>
      )}
      {note && (
        <Note role="status" className="pv-col__note">
          {note}
        </Note>
      )}
      <div className="pv-col__area" ref={areaRef} data-state={state}>
        <div className="pv-col__fit" ref={boxRef}>
          <iframe
            key={frameKey}
            ref={frameRef}
            className="pv-col__frame"
            src={src}
            title={`Live preview of ${title}`}
            onLoad={loaded}
          />
        </div>
        {state === 'loading' && (
          <p className="pv-col__loading" role="status">
            {PREVIEW_LOADING}
          </p>
        )}
      </div>
    </div>
  );
}
