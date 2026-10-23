import { useEffect, useId, useRef, useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { savebarLead, savebarShown, savebarSub, type SavebarCounts } from './model';

// The savebar (Admin v2 R12; releases.md §7, ui.md §2.10, the prototype's .savebar): a fixed
// midnight pill at the bottom centre while there is anything unpublished the person may read.
//   - "You have 3 unpublished changes" and "2 in Pages · 1 in Services", or, with nothing
//     theirs to publish, "2 unpublished changes waiting for someone who can publish them";
//   - Discard (a menu: "Discard my changes (k)", "Choose…"), Preview (the site with every
//     pending change, a new tab), and Publish (a role that may publish something) or Review;
//   - a region named "Unpublished changes"; its count is announced politely, debounced, by a
//     status line that is in the page from the first render (a live region announces changes,
//     not its own arrival); the page gets scroll padding so the bar never hides focus (WCAG
//     2.2 2.4.11, admin.css); reduced motion drops the slide-in.
// Classes and data attributes only (CSP: no style attribute).

export interface SavebarProps {
  counts: SavebarCounts;
  /** Opens the dialog: to publish, to review (nothing of mine to publish) or to choose discards. */
  onOpen: (mode: 'publish' | 'review' | 'discard') => void;
  onDiscardMine: () => void;
  /** While a discard or a publish is on its way. */
  busy?: boolean;
  /** The kit's gallery: in the page, not fixed over it. */
  inline?: boolean;
  /** A discard that failed, said in the bar (toasts are for success only). */
  error?: string;
}

/** The words a screen reader hears when the count moves (after a pause, so typing is quiet). */
function announcement(counts: SavebarCounts): string {
  return savebarShown(counts) ? savebarLead(counts) : 'No unpublished changes';
}

export default function Savebar({
  counts,
  onOpen,
  onDiscardMine,
  busy = false,
  inline = false,
  error = '',
}: SavebarProps) {
  const shown = savebarShown(counts);
  const [menu, setMenu] = useState(false);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const [heard, setHeard] = useState('');
  const first = useRef(true);
  const said = announcement(counts);

  // Announce a change of count after a second of quiet (an autosave every few seconds is one
  // announcement); never on the first render (the page already shows it).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = window.setTimeout(() => setHeard(said), 1000);
    return () => window.clearTimeout(timer);
  }, [said]);

  // The Discard menu closes on Escape and on a press outside it, focus back on its button.
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(false);
        menuRef.current?.querySelector<HTMLButtonElement>('[aria-controls]')?.focus();
      }
    };
    const onDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenu(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [menu]);

  const sub = savebarSub(counts);
  const canPublish = counts.publishable > 0;
  return (
    <>
      <p className="visually-hidden" role="status">
        {heard}
      </p>
      {shown && (
        <div
          className="savebar"
          role="region"
          aria-label="Unpublished changes"
          data-shown=""
          data-inline={inline ? '' : undefined}
        >
          <span className="savebar__dot" aria-hidden="true" />
          <div className="savebar__text">
            <p className="savebar__lead">{savebarLead(counts)}</p>
            {sub && <p className="savebar__sub">{sub}</p>}
            {error && (
              <p className="savebar__error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="savebar__acts">
            {counts.mine > 0 || canPublish ? (
              <div className="savebar__menu" ref={menuRef}>
                <button
                  type="button"
                  data-variant="ghost"
                  aria-expanded={menu}
                  aria-controls={menuId}
                  disabled={busy}
                  onClick={() => setMenu((open) => !open)}
                >
                  Discard
                  <Icon name="chevd" size={14} />
                </button>
                <ul className="savebar__list" id={menuId} hidden={!menu}>
                  {counts.mine > 0 && (
                    <li>
                      <button
                        type="button"
                        onClick={() => {
                          setMenu(false);
                          onDiscardMine();
                        }}
                      >
                        Discard my changes ({counts.mine})
                      </button>
                    </li>
                  )}
                  <li>
                    <button
                      type="button"
                      onClick={() => {
                        setMenu(false);
                        onOpen('discard');
                      }}
                    >
                      Choose…
                    </button>
                  </li>
                </ul>
              </div>
            ) : null}
            <a
              className="btn"
              data-variant="ghost"
              href="/admin/preview/"
              target="_blank"
              rel="noopener"
            >
              <Icon name="eye" size={15} />
              Preview
            </a>
            {canPublish ? (
              <button
                type="button"
                data-variant="primary"
                disabled={busy}
                onClick={() => onOpen('publish')}
              >
                <Icon name="upload" size={15} />
                Publish…
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => onOpen('review')}>
                Review…
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
