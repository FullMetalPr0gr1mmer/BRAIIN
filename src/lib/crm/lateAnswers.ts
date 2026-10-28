// Late answers on the leads screens (C4 star race): an answer that left before a change was
// saved must not undo that change on screen.
//
// Two shapes, one per screen:
//   • RowToggles, for the list. Its toggles (the star; any later row toggle, by field name) are
//     optimistic: the row shows the new value before the write answers. A list read (a search,
//     a filter, a page) that left before the write was saved answers with the old value, and
//     used to draw the star off again while the database had it on. Each read and each toggle
//     takes a stamp from one clock; a toggle is laid over every answer whose read left before
//     all of the toggle's writes had answered, and dropped once a read that left after them
//     answers (that answer holds it).
//   • AnswerOrder, for a lead's page. It is not optimistic (it shows each write's answer), but
//     a read sent before a write answered (the refetch after "Log contact") or an earlier
//     write's answer (the mark-read PATCH sent on opening) could arrive last and replace the
//     row: the star off again, an old version (the next versioned change then a needless 409).
//     An answer is used only when no write answered after it was sent.
//
// Pure and DOM-free, so the rules are unit-tested (tests/lib/lateAnswers.spec.ts); the islands
// keep one instance in a ref. Nothing here reads a field the island did not set on its own row:
// no contact detail, budget or note passes through (CLAUDE.md §3).

interface Toggle {
  id: string;
  field: string;
  /** What the row shows. */
  value: unknown;
  /** What the server holds, as far as this screen knows: the value before the first toggle,
   * then each write that answered OK. */
  confirmed: unknown;
  /** The writes still out, by token, with the value each sent. */
  out: Map<number, unknown>;
  /** The stamp at which the last write out answered, or null while one is out. */
  settledAt: number | null;
}

/** One row's field set to a value, every other row left as it is. */
export function withField<R extends { id: string }>(
  rows: readonly R[],
  id: string,
  field: string,
  value: unknown,
): R[] {
  return rows.map((row) => (row.id === id ? { ...row, [field]: value } : row));
}

export class RowToggles {
  private clock = 0;
  /** The stamp of the newest read whose answer was used (0: the server's first render). */
  private used = 0;
  private toggles = new Map<string, Toggle>();

  /** A list read leaves: its stamp, handed back with its answer. */
  read(): number {
    return ++this.clock;
  }

  /**
   * A toggle is shown and its write leaves. `shown` is what the row showed before it.
   * Returns the write's token, handed back to `settle` when it answers.
   */
  begin(id: string, field: string, value: unknown, shown: unknown): number {
    const key = `${id}\u0000${field}`;
    const token = ++this.clock;
    const toggle = this.toggles.get(key) ?? {
      id,
      field,
      value,
      confirmed: shown,
      out: new Map<number, unknown>(),
      settledAt: null,
    };
    toggle.value = value;
    toggle.out.set(token, value);
    toggle.settledAt = null;
    this.toggles.set(key, toggle);
    return token;
  }

  /**
   * A write answered (`ok`) or failed. Returns what the row should show now that every write of
   * that field has answered (a failure puts back what the server is known to hold), or null
   * while another write of the field is still out (its answer decides) or the token is unknown.
   */
  settle(token: number, ok: boolean): { id: string; field: string; value: unknown } | null {
    for (const toggle of this.toggles.values()) {
      if (!toggle.out.has(token)) continue;
      const sent = toggle.out.get(token);
      toggle.out.delete(token);
      if (ok) toggle.confirmed = sent;
      if (toggle.out.size > 0) return null;
      toggle.value = toggle.confirmed;
      toggle.settledAt = ++this.clock;
      return { id: toggle.id, field: toggle.field, value: toggle.value };
    }
    return null;
  }

  /**
   * A list answer, read at `stamp`. Null when a newer read's answer was already used (drop it
   * whole); else the answer's rows with every toggle it may predate laid over them.
   */
  answer<R extends { id: string }>(rows: readonly R[], stamp: number): R[] | null {
    if (stamp < this.used) return null;
    this.used = stamp;
    let out = [...rows];
    for (const [key, toggle] of this.toggles) {
      // Every write answered before this read left: the answer holds what the server kept.
      if (toggle.settledAt !== null && toggle.settledAt < stamp) {
        this.toggles.delete(key);
        continue;
      }
      out = withField(out, toggle.id, toggle.field, toggle.value);
    }
    return out;
  }
}

export class AnswerOrder {
  private clock = 0;
  /** The stamp at which the last write answered (0: none yet). */
  private wrote = 0;

  /** A read or a write leaves: its stamp, handed back with its answer. */
  send(): number {
    return ++this.clock;
  }

  /**
   * An answer sent at `sent` arrives: true when it may be shown (no write answered after it was
   * sent). `write` marks a write's answer, after which any answer sent before it is stale.
   */
  accept(sent: number, write: boolean): boolean {
    const fresh = this.wrote < sent;
    if (write) this.wrote = ++this.clock;
    return fresh;
  }
}
