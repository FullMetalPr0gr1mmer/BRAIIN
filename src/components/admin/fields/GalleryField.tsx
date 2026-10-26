import { useEffect, useRef, useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { MoveButtons, SortHandle, SortHint } from '@/components/admin/kit/Sortable';
import { useSortable } from '@/components/admin/kit/useSortable';
import { adminFetch } from '@/lib/admin/client';
import type { FieldComponentProps } from './types';
import type { MediaRow } from './media/format';
import MediaPicker from './media/MediaPicker';

// An ordered list of pictures as a square grid (Admin v2 U6, a project's gallery: AV-15's
// "a keyboard-sortable grid with remove buttons", in place of the prototype's "Click an image
// to remove it. Order follows the grid."). Each tile is one item of the field's value (an
// item as a repeater holds it: `{kind, mediaId, …}`): its thumbnail, its number, the kit's
// Sortable handle ("Reorder image 2": drag it, or Space, the arrows and Space), Move up /
// Move down (WCAG 2.5.7: a drag is never the only way) and "Remove image 2". "Add an image"
// opens the media library's picker (U4: one picture a pick, as its API is frozen), which adds
// the picture at the end. Keys an item holds that the grid does not draw (a caption, a
// layout, a video's clip) are kept as they are, so nothing stored is lost by a reorder.
//
// The thumbnails are read once per picture (GET /api/admin/media/<id>, as MediaField reads
// its one), so a gallery of twelve costs twelve small reads when its tab first opens. The
// field's id (`<prefix>-<name>`) is the fieldset's, where a save's error about the gallery
// lands (fieldErrors.ts). No `style=` (CSP).

type Item = Record<string, unknown>;

/** A picture's English alt text, for its tile's <img> (empty when it has none). */
function altOf(row: MediaRow | null | undefined): string {
  const alt = row?.['alt'] && typeof row['alt'] === 'object' ? (row['alt'] as MediaRow) : {};
  return typeof alt['en'] === 'string' ? alt['en'].trim() : '';
}

/** The words a tile is named by: "Image 2", "Video 3". */
export function tileName(item: Item, index: number): string {
  return `${item['kind'] === 'video' ? 'Video' : 'Image'} ${index + 1}`;
}

export default function GalleryField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
}: FieldComponentProps) {
  const items = Array.isArray(value) ? (value as Item[]) : [];
  const base = `${idPrefix}-${field.name}`;
  const max = field.maxItems;
  const full = max !== undefined && items.length >= max;

  // Each tile's key for React and the Sortable core, kept in step with every change made
  // here; a list that grows or shrinks from outside (a load) is keyed again (as RepeaterField).
  const added = useRef(0);
  const keys = useRef<string[]>([]);
  if (keys.current.length !== items.length) {
    keys.current = items.map((_, i) => `${base}:${i}`);
  }
  const commit = (next: Item[], nextKeys: string[]) => {
    keys.current = nextKeys;
    onChange(field.name, next);
  };

  const { ref, lists, hintId } = useSortable<HTMLOListElement>({
    orientation: 'horizontal',
    lists: { list: keys.current },
    onCommit: (next) => {
      const order = next['list'] ?? [];
      const byKey = new Map(keys.current.map((k, i) => [k, items[i] as Item]));
      commit(
        order.map((k) => byKey.get(k) ?? {}),
        [...order],
      );
    },
  });

  // The pictures' rows (thumbnail and name), read once each.
  const [rows, setRows] = useState<Readonly<Record<string, MediaRow | null>>>({});
  const ids = [
    ...new Set(items.map((item) => item['mediaId']).filter((id) => typeof id === 'string')),
  ] as string[];
  const missing = ids.filter((id) => id !== '' && !(id in rows));
  useEffect(() => {
    if (missing.length === 0) return;
    const controller = new AbortController();
    for (const id of missing) {
      adminFetch<MediaRow>(`/api/admin/media/${id}`, { signal: controller.signal })
        .then((row) => setRows((current) => ({ ...current, [id]: row })))
        .catch(() => setRows((current) => ({ ...current, [id]: null })));
    }
    return () => controller.abort();
  }, [missing.join(',')]);

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const order = lists['list'] ?? keys.current;
  const groupError = errors?.[base];
  const count = max !== undefined ? `${items.length} of ${max}` : `${items.length}`;

  return (
    <fieldset
      id={base}
      tabIndex={-1}
      className="f f--group"
      aria-describedby={groupError ? `${base}-error` : undefined}
    >
      <legend className="field-legend">{field.label}</legend>
      <div className="f__bar">
        <span className="f__meta">{count === '1' ? '1 image' : `${count} images`}</span>
      </div>
      {items.length === 0 && <p className="admin-sub">No images yet.</p>}
      <ol className="gal__grid" ref={ref} aria-label={field.label}>
        {order.map((key) => {
          const index = keys.current.indexOf(key);
          const item = items[index];
          if (!item || index === -1) return null;
          const name = tileName(item, index);
          const mediaId = typeof item['mediaId'] === 'string' ? item['mediaId'] : '';
          const row = mediaId ? rows[mediaId] : null;
          const thumb = row && typeof row['thumb_url'] === 'string' ? row['thumb_url'] : null;
          const alt = altOf(row);
          return (
            <li key={key} className="gal__i" data-sortable-id={key} data-sortable-label={name}>
              <span className="gal__pv">
                {thumb ? (
                  <img src={thumb} alt={alt} width="160" height="160" />
                ) : (
                  <Icon name={item['kind'] === 'video' ? 'video' : 'image'} size={22} />
                )}
              </span>
              <span className="gal__n" aria-hidden="true">
                {index + 1}
              </span>
              <span className="gal__acts">
                <SortHandle label={name} describedBy={hintId} />
                <MoveButtons label={name} />
                <button
                  type="button"
                  className="icon-btn"
                  data-variant="danger"
                  aria-label={`Remove ${name.toLowerCase()}`}
                  onClick={() =>
                    commit(
                      items.filter((_, i) => i !== index),
                      keys.current.filter((_, i) => i !== index),
                    )
                  }
                >
                  <Icon name="trash" size={15} />
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <SortHint id={hintId} />
      <button
        type="button"
        className="repeat__add"
        data-variant="soft"
        disabled={full}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
      >
        <Icon name="plus" size={14} />
        {full ? `At most ${max}` : 'Add an image'}
      </button>
      {mounted && (
        <MediaPicker
          open={open}
          onClose={() => setOpen(false)}
          onPick={(picked) => {
            const id = String(picked['id']);
            setRows((current) => ({ ...current, [id]: picked }));
            commit(
              [...items, { kind: 'image', mediaId: id }],
              [...keys.current, `${base}:n${++added.current}`],
            );
          }}
          title={`${field.label}: choose`}
          upload={field.media?.upload !== false}
        />
      )}
      {groupError && (
        <p id={`${base}-error`} className="field-error f__err">
          {groupError}
        </p>
      )}
      {field.help && <p className="f__hint">{field.help}</p>}
    </fieldset>
  );
}
