import { useEffect, useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { adminFetch } from '@/lib/admin/client';
import FieldShell from './FieldShell';
import type { FieldComponentProps } from './types';
import { altGap, caption, type MediaRow } from './media/format';
import MediaPicker from './media/MediaPicker';

// One media asset, chosen in the media library's picker. The field stores the asset's id;
// the page resolves it to an image server-side.
//
// v2 (Admin v2 F5a, ui.md §2.6, the prototype's .imgf): the choice is a tile, its thumbnail
// beside its name, Choose (or Change) and Remove, and a badge when its alt text is missing
// ("No alt text", "No Arabic alt"): the picture is chosen here, its words are written in
// the media library.
//
// U4: Choose opens the library's own grid (fields/media/MediaPicker.tsx: a search over
// names, alt text and tags, pages, Enter or a double click to choose) with Upload in place
// for the roles and Workers that can take a file (`media.upload: false` on the field hides
// it). The picker is mounted on the first Choose, so a form's server HTML holds the tile
// only, and its dialog lives at the end of <body>, outside the edit form.
//
// Frozen since F5a (U5 and U6 build on it): the default export and its props, `altGap`, the
// tile's markup, and the picker's name, "<Label>: choose".

export { altGap };

/** The tile's words: the picture's name, its id when it could not be read, or none chosen. */
function tileCaption(current: MediaRow | null): string {
  if (!current) return 'No image chosen';
  // A read that failed keeps only the id (the asset was deleted, or the role cannot read it).
  if (Object.keys(current).length === 1) return String(current['id'] ?? '');
  return caption(current);
}

export default function MediaField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
}: FieldComponentProps) {
  const id = `${idPrefix}-${field.name}`;
  const [current, setCurrent] = useState<MediaRow | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const selectedId = typeof value === 'string' ? value : '';

  // Describe the stored selection (it may not be on the first page of the picker).
  useEffect(() => {
    if (!selectedId) {
      setCurrent(null);
      return;
    }
    const controller = new AbortController();
    adminFetch<MediaRow>(`/api/admin/media/${selectedId}`, { signal: controller.signal })
      .then(setCurrent)
      .catch(() => setCurrent({ id: selectedId }));
    return () => controller.abort();
  }, [selectedId]);

  function choose() {
    setMounted(true);
    setOpen(true);
  }

  const gap = altGap(current);
  return (
    // A fieldset, so the Choose/Change/Remove buttons are announced with the field's name
    // ("Poster, group") — several media fields on one form would otherwise read alike.
    <FieldShell
      as="fieldset"
      id={id}
      label={field.label}
      required={field.required}
      hint={field.help}
      error={errors?.[id]}
    >
      <div className="imgf">
        <div className="imgf__pv">
          {current && typeof current['thumb_url'] === 'string' ? (
            <img src={current['thumb_url']} alt="" width="96" height="64" />
          ) : (
            <Icon name="image" size={20} />
          )}
        </div>
        <div className="imgf__body">
          <span className="item-label">{tileCaption(current)}</span>
          {gap && (
            <span className="badge" data-tone="warn">
              {gap}
            </span>
          )}
          <span className="imgf__acts">
            <button type="button" className="btn" onClick={choose}>
              <Icon name="image" size={14} />
              {selectedId ? 'Change…' : 'Choose…'}
            </button>
            {selectedId && (
              <button
                type="button"
                className="btn"
                data-variant="ghost"
                onClick={() => onChange(field.name, '')}
              >
                Remove
              </button>
            )}
          </span>
        </div>
      </div>

      {mounted && (
        <MediaPicker
          open={open}
          onClose={() => setOpen(false)}
          onPick={(row) => {
            setCurrent(row);
            onChange(field.name, String(row['id']));
          }}
          title={`${field.label}: choose`}
          selectedId={selectedId || null}
          upload={field.media?.upload !== false}
        />
      )}
    </FieldShell>
  );
}
