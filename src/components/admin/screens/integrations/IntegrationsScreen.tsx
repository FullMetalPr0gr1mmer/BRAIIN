import { useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { adminFetch, describeError } from '@/lib/admin/client';
import {
  integrationTiles,
  tileStatus,
  type IntegrationKey,
  type IntegrationTile,
} from '@/lib/admin/integrations/tiles';
import { integrationsView, type IntegrationsView } from '@/lib/admin/integrations/view';
import IntegrationDrawer, { INTEGRATIONS_ENDPOINT } from './IntegrationDrawer';

// /admin/integrations's island (Admin v2 U11, the prototype's settings/integrations grid):
// the page reads the row on the server (Admin + SEO; anyone else gets the page's 403 and
// nothing is read) and hands its values here, so the tiles and their statuses are in the
// server HTML. A tile's button opens its drawer, whose form loads the row afresh and saves
// one field (useEntitySave, the field kit). When the drawer closes, the row is read once more
// and the tiles follow it.

export interface IntegrationsScreenProps {
  initial: IntegrationsView;
  /** The captcha tile links to the Forms overview for settings.general holders. */
  canSeeForms: boolean;
  /** The site loads GA4 (GA4_NOTICE_READY, read by the page on the server, Admin v2 U15). */
  ga4Live?: boolean;
}

export default function IntegrationsScreen({
  initial,
  canSeeForms,
  ga4Live = false,
}: IntegrationsScreenProps) {
  const [view, setView] = useState(initial);
  const [open, setOpen] = useState<IntegrationKey | null>(null);
  const [refreshError, setRefreshError] = useState('');
  const tiles = integrationTiles(ga4Live);
  const openTile = tiles.find((tile) => tile.key === open) ?? null;

  async function refresh() {
    try {
      setView(integrationsView(await adminFetch(INTEGRATIONS_ENDPOINT)));
      setRefreshError('');
    } catch (err) {
      setRefreshError(
        `The tiles could not be updated: ${describeError(err)} Reload the page to see the latest.`,
      );
    }
  }

  return (
    <>
      {refreshError && (
        <p className="msg" data-kind="error" role="alert">
          {refreshError}
        </p>
      )}
      <ul className="grid grid--3 int-grid" aria-label="Integrations">
        {tiles.map((tile) => (
          <Tile
            key={tile.key}
            tile={tile}
            view={view}
            canSeeForms={canSeeForms}
            onOpen={() => setOpen(tile.key)}
          />
        ))}
      </ul>
      {openTile && (
        <IntegrationDrawer
          key={openTile.key}
          tile={openTile}
          onClose={() => {
            setOpen(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}

interface TileProps {
  tile: IntegrationTile;
  view: IntegrationsView;
  canSeeForms: boolean;
  onOpen: () => void;
}

function Tile({ tile, view, canSeeForms, onOpen }: TileProps) {
  const status = tileStatus(tile, view);
  const value = tile.value ? view[tile.value] : null;
  return (
    <li className="card int-tile" data-integration={tile.key}>
      <div className="int-tile__top">
        <span className="li__ico int-tile__ico" aria-hidden="true">
          <Icon name={tile.icon} />
        </span>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <div>
        <h2 className="int-tile__name">{tile.name}</h2>
        <p className="int-tile__desc">{tile.description}</p>
      </div>
      {value && (
        <p className="int-tile__value">
          <span className="visually-hidden">Saved: </span>
          <code dir="ltr">{value}</code>
        </p>
      )}
      {value && tile.waiting && <Note tone={tile.waiting.tone}>{tile.waiting.text}</Note>}
      {tile.field ? (
        <button
          type="button"
          className="int-tile__act"
          data-variant={value ? undefined : 'primary'}
          onClick={onOpen}
        >
          {value ? 'Edit' : 'Set up'}
          <span className="visually-hidden"> {tile.name}</span>
        </button>
      ) : (
        <>
          {tile.notes.map((note) => (
            <Note key={note.text} tone={note.tone}>
              {note.text}
            </Note>
          ))}
          {canSeeForms && (
            <a className="btn int-tile__act" href="/admin/forms">
              How forms are protected
            </a>
          )}
        </>
      )}
    </li>
  );
}
