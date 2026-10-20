import { useEffect, useRef, useState } from 'react';
import Avatar from '@/components/admin/kit/Avatar';
import Icon from '@/components/admin/kit/Icon';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { isoOf } from '@/lib/admin/relTime';
import { useClock } from '@/components/admin/kit/clock';
import type { LeadsFrame, StageView } from '@/lib/crm/leadPage';
import type { BoardColumn, LeadCard } from '@/lib/crm/leadReads';
import { boardFilters, boardQueryOf, withLeadFilters, type LeadFilters } from '@/lib/crm/leadUrl';
import { formatSar } from '@/lib/crm/leadView';
import MoveTo from './MoveTo';
import { LeadFilterSelects, LeadSearch } from './LeadsToolbar';
import {
  assigneeName,
  interestText,
  leadName,
  text,
  useAddLead,
  type LeadsPermissions,
} from './shared';

// The pipeline board (Admin v2 C4b, crm.md §11 screen 2): a column per stage, non-spam leads
// only, each with its count, the won column with its value in SAR, at most 50 cards a column
// and "Show all in the list" past that. Every card has "Move to…" (MoveTo.tsx), the keyboard
// and single-press way to change a stage; a move is one versioned PATCH, announced in the
// island's status region ("Moved Sara to Proposal sent"), and focus follows the card to its
// new column. A conflict (someone else changed the lead) re-reads the board and says so.
// Pointer drag is not built (decision D5: optional; recorded in deviations.md).
//
// The board scrolls sideways inside its own focusable region at a phone's width, never the
// page (risk R12). Cards carry the safe columns only: no budget, e-mail or phone.

export interface LeadsBoardProps {
  frame: LeadsFrame;
  initial: BoardColumn[] | null;
  filters: LeadFilters;
  permissions: LeadsPermissions;
  now: string;
}

type Card = LeadCard & { id: string };

interface Column {
  stage: StageView;
  total: number;
  value: number;
  cards: Card[];
}

/** The board's columns in the stages' order: a stage the answer did not list is empty. */
function columnsOf(stages: readonly StageView[], answer: BoardColumn[] | null): Column[] {
  return stages.map((stage) => {
    const found = answer?.find((column) => column.stage_id === stage.id);
    return {
      stage,
      total: found?.total ?? 0,
      value: found?.value_sum ?? 0,
      cards: (found?.leads ?? []).filter((card): card is Card => typeof card.id === 'string'),
    };
  });
}

/** One move, applied to the columns as the server answered it (the card first in its new column). */
function moved(columns: Column[], card: Card, to: StageView, answer: Record<string, unknown>) {
  const value = Number(card.value_sar ?? 0) || 0;
  const updated: Card = { ...card, stage_id: to.id, version: answer['version'] ?? card.version };
  return columns.map((column) => {
    if (column.stage.id === card.stage_id) {
      return {
        ...column,
        total: Math.max(0, column.total - 1),
        value: column.value - value,
        cards: column.cards.filter((c) => c.id !== card.id),
      };
    }
    if (column.stage.id === to.id) {
      return {
        ...column,
        total: column.total + 1,
        value: column.value + value,
        cards: [updated, ...column.cards],
      };
    }
    return column;
  });
}

/**
 * Whether the moved card's link takes focus after the board is redrawn: only when focus was
 * lost (nothing, or the body: the card's "Move to…" left with it for another column). Never
 * taken from where the person went while the move was saved, nor from the card's own button
 * when a refresh left it where it was (MoveTo gives focus back to it; C4b's WCAG 2.4.3 fix).
 */
export function cardTakesFocus(active: Element | null, body: Element | null): boolean {
  return active === null || active === body;
}

/**
 * What takes focus once the board is redrawn after a move or a conflict's refresh: the card's
 * link wherever it now is; else, when the refresh no longer holds the card (a colleague marked
 * it spam, which the board leaves out, or it now falls outside the filters), the heading of
 * the column it left; else the board's region. Never nothing, so focus is not left on the
 * page's body (WCAG 2.4.3).
 */
export function focusTargetAfterMove(
  root: Pick<ParentNode, 'querySelector'>,
  id: string,
  from: string,
): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>(`[data-lead-card="${id}"] .kcard__n`) ??
    root.querySelector<HTMLElement>(`[id="kb-${from}"]`) ??
    root.querySelector<HTMLElement>('.kb')
  );
}

export default function LeadsBoard({
  frame,
  initial,
  filters: start,
  permissions,
  now: renderedAt,
}: LeadsBoardProps) {
  const { formatDateTime, relTime, zone } = useClock();
  const { stages, people, disciplines } = frame;
  // Only what the toolbar shows: the address and the cards' links never carry a chip, sort or
  // page the board has no control for (boardFilters).
  const [filters, setFilters] = useState<LeadFilters>(() => boardFilters(start));
  const [q, setQ] = useState('');
  const [columns, setColumns] = useState<Column[]>(() => columnsOf(stages, initial));
  const [error, setError] = useState(
    initial ? '' : 'The pipeline could not be loaded just now. Try again in a moment.',
  );
  const [searchError, setSearchError] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => Date.parse(renderedAt));
  const focusAfter = useRef<{ id: string; from: string } | null>(null);
  // The board read in flight, if any: one that started before a move answers with the card
  // where it was, so a move asks again rather than let that answer redraw it there.
  const reading = useRef<AbortController | null>(null);
  const addLead = useAddLead(permissions.canSeePii, disciplines);

  useEffect(() => {
    const href = withLeadFilters('/admin/leads/board', boardFilters(filters));
    if (`${location.pathname}${location.search}` !== href) history.replaceState(null, '', href);
  }, [filters]);

  const loaded = useRef(initial !== null);
  useEffect(() => {
    if (loaded.current) {
      loaded.current = false;
      return;
    }
    const controller = new AbortController();
    reading.current = controller;
    adminFetch<{ columns: BoardColumn[] }>('/api/admin/leads/board', {
      method: 'POST',
      body: { ...boardQueryOf(filters, new Date(), undefined, zone), ...(q ? { q } : {}) },
      signal: controller.signal,
    })
      .then((answer) => {
        setColumns(columnsOf(stages, answer.columns));
        setError('');
        setSearchError('');
        setNow(Date.now());
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        focusAfter.current = null;
        if (err instanceof AdminApiError && err.info.status === 422 && q) {
          setSearchError(err.info.detail ?? describeError(err));
          return;
        }
        setError(describeError(err));
      })
      .finally(() => {
        if (reading.current === controller) reading.current = null;
      });
    return () => controller.abort();
  }, [filters, q, reload]);

  // After a move, or the refresh a conflict asks for, focus goes to the card wherever it now
  // is, if focus was lost with its old place (cardTakesFocus).
  useEffect(() => {
    const after = focusAfter.current;
    if (!after) return;
    focusAfter.current = null;
    if (!cardTakesFocus(document.activeElement, document.body)) return;
    focusTargetAfterMove(document, after.id, after.from)?.focus();
  }, [columns]);

  async function move(card: Card, to: StageView) {
    const name = leadName(card);
    setBusy(card.id);
    setError('');
    try {
      const answer = await adminFetch<Record<string, unknown>>(`/api/admin/leads/${card.id}`, {
        method: 'PATCH',
        body: { version: Number(card.version) || 1, stageId: to.id },
      });
      focusAfter.current = { id: card.id, from: String(card.stage_id) };
      setColumns((list) => moved(list, card, to, answer));
      setSaid(`Moved ${name} to ${to.label}.`);
      // A filter or search read that started before this move would redraw the card in its
      // old column with its old version (the next move then a needless 409): read again.
      if (reading.current) setReload((n) => n + 1);
    } catch (err) {
      if (err instanceof AdminApiError && err.info.status === 409) {
        setSaid(`Someone else changed ${name}. Refreshed.`);
        // The refresh may put the card in another column, taking its focused button with it.
        focusAfter.current = { id: card.id, from: String(card.stage_id) };
        setReload((n) => n + 1);
      } else {
        setError(`${name} could not be moved. ${describeError(err)}`);
      }
    } finally {
      setBusy(null);
    }
  }

  const listHref = (stage: StageView) =>
    withLeadFilters('/admin/leads', { ...filters, chip: { kind: 'stage', id: stage.id }, page: 1 });

  return (
    <>
      <div className="toolbar">
        <LeadSearch
          value={q}
          label="Search the pipeline"
          error={searchError}
          onSearch={(term) => {
            setQ(term);
            setSearchError('');
          }}
        />
      </div>
      <LeadFilterSelects
        filters={filters}
        onChange={setFilters}
        people={people}
        disciplines={disciplines}
        withSort={false}
      />
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      <p className="visually-hidden" role="status">
        {said}
      </p>
      {/* A region a keyboard can scroll: five columns are wider than a phone (risk R12). */}
      <div className="kb" role="region" aria-label="Pipeline" tabIndex={0}>
        {columns.map((column) => {
          const headingId = `kb-${column.stage.id}`;
          return (
            <section key={column.stage.id} className="kb__col" aria-labelledby={headingId}>
              <div className="kb__h">
                <span className="kb__dot" data-tone={column.stage.tone} aria-hidden="true" />
                <h2 id={headingId} className="kb__t" tabIndex={-1}>
                  {column.stage.label}
                </h2>
                {column.stage.kind === 'won' && (
                  <span className="kb__sum">{formatSar(column.value)}</span>
                )}
                <span className="kb__cnt">
                  {column.total}
                  <span className="visually-hidden">{column.total === 1 ? ' lead' : ' leads'}</span>
                </span>
              </div>
              {column.cards.length === 0 ? (
                <p className="kb__empty">No leads here</p>
              ) : (
                <ol className="kb__b">
                  {column.cards.map((card) => {
                    const name = leadName(card);
                    const at = text(card.created_at);
                    const who = assigneeName(card.assigned_to, people);
                    const value = Number(card.value_sar);
                    return (
                      <li key={card.id}>
                        <article className="kcard" data-lead-card={card.id}>
                          <a
                            className="kcard__n"
                            dir="auto"
                            href={withLeadFilters(`/admin/leads/${card.id}`, boardFilters(filters))}
                          >
                            {name}
                          </a>
                          {text(card.company) && (
                            <p className="kcard__s" dir="auto">
                              {text(card.company)}
                            </p>
                          )}
                          <p className="kcard__s">{interestText(card)}</p>
                          {card.value_sar !== null && Number.isFinite(value) && (
                            <p className="kcard__s">{formatSar(value)}</p>
                          )}
                          <div className="kcard__f">
                            <time dateTime={isoOf(at)} title={formatDateTime(at)}>
                              {relTime(at, now)}
                            </time>
                            {who && (
                              <Avatar
                                name={who}
                                toneKey={String(card.assigned_to)}
                                size="sm"
                                label={`Assigned to ${who}`}
                              />
                            )}
                            {card.is_starred === true && (
                              <span className="kcard__mark">
                                <Icon name="star" size={14} />
                                <span className="visually-hidden">Starred</span>
                              </span>
                            )}
                            {card.read_at === null && (
                              <>
                                <span className="lead-dot" aria-hidden="true" />
                                <span className="visually-hidden">Unread</span>
                              </>
                            )}
                            <MoveTo
                              name={name}
                              stages={stages}
                              current={card.stage_id}
                              disabled={busy !== null}
                              onMove={(to) => void move(card, to)}
                            />
                          </div>
                        </article>
                      </li>
                    );
                  })}
                </ol>
              )}
              {column.total > column.cards.length && (
                <p className="kb__more">
                  <a href={listHref(column.stage)}>
                    Show all {column.total} in the list
                    <span className="visually-hidden"> ({column.stage.label})</span>
                  </a>
                </p>
              )}
            </section>
          );
        })}
      </div>
      {addLead}
    </>
  );
}
