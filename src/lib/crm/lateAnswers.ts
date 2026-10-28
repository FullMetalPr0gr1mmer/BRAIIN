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
//     answers can arrive in any order: a read sent before a write answered (the refetch after
//     "Log contact" or after a 409), an earlier write's answer (the mark-read PATCH sent on
//     opening), or a write's answer after a read sent later was already shown. Each used to
//     replace a newer row: the star off again, an old version (the next versioned change then a
//     needless 409). An answer is shown only when nothing sent after it has been shown; a
//     read's answer only when no write answered after the read was sent; a write's answer only
//     when no write sent after it has answered. A write's answer that is not shown leaves the
//     order unknown (the server may have run the write after the row on screen was read), so
//     the island reads the lead again.
//   • RowToggles.forget, for another write of the same field from the same screen (the bulk
//     bar's Star): a single toggle still out when it lands may have run before or after it, so
//     the toggle stops overriding answers and the list is read again once its writes answer.
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
  /** Another write of this field from the screen (a bulk Star) landed while this toggle's
   * writes were out: which ran last is unknown, so the toggle overrides nothing and the list
   * is read again once its writes answer. */
  detached: boolean;
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
      detached: false,
    };
    toggle.value = value;
    toggle.out.set(token, value);
    toggle.settledAt = null;
    // A press after the other write answered is the newest write of the field from here.
    toggle.detached = false;
    this.toggles.set(key, toggle);
    return token;
  }

  /**
   * A write answered (`ok`) or failed. Returns what the row should show now that every write of
   * that field has answered (a failure puts back what the server is known to hold); `'reread'`
   * when the toggle was detached by `forget` (read the list again: only a read can tell which
   * write ran last); or null while another write of the field is still out (its answer
   * decides) or the token is unknown.
   */
  settle(
    token: number,
    ok: boolean,
  ): { id: string; field: string; value: unknown } | 'reread' | null {
    for (const [key, toggle] of this.toggles) {
      if (!toggle.out.has(token)) continue;
      const sent = toggle.out.get(token);
      toggle.out.delete(token);
      if (ok) toggle.confirmed = sent;
      if (toggle.out.size > 0) return null;
      if (toggle.detached) {
        this.toggles.delete(key);
        return 'reread';
      }
      toggle.value = toggle.confirmed;
      toggle.settledAt = ++this.clock;
      return { id: toggle.id, field: toggle.field, value: toggle.value };
    }
    return null;
  }

  /**
   * Another write of `field` on these rows answered (a bulk action), and the caller is about to
   * read the list again. A toggle whose writes have all answered is dropped (that read holds
   * the result); one with a write still out is detached: the server may run it before or after
   * the other write, so it no longer overrides any answer, and its `settle` asks for a read.
   */
  forget(ids: readonly string[], field: string): void {
    const set = new Set(ids);
    for (const [key, toggle] of this.toggles) {
      if (toggle.field !== field || !set.has(toggle.id)) continue;
      if (toggle.out.size === 0) this.toggles.delete(key);
      else toggle.detached = true;
    }
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
      if (toggle.detached) continue;
      out = withField(out, toggle.id, toggle.field, toggle.value);
    }
    return out;
  }
}

export class AnswerOrder {
  private clock = 0;
  /** The stamp at which the last write answered (0: none yet). */
  private answeredAt = 0;
  /** The send stamp of the newest-sent write that has answered (0: none yet). */
  private newestWrite = 0;
  /** The send stamp of the newest-sent answer shown, read or write (0: the server's render). */
  private shown = 0;

  /** A read or a write leaves: its stamp, handed back with its answer. */
  send(): number {
    return ++this.clock;
  }

  /**
   * An answer sent at `sent` arrives: true when it may be shown. Any answer is stale once an
   * answer sent after it has been shown; a read's answer also once any write answered after
   * the read left (the read may predate it); a write's answer also once a write sent after it
   * has answered. Every write's answer counts, shown or not. A write's answer that is not shown
   * is the caller's cue to read the lead again: the row on screen may predate that write.
   */
  accept(sent: number, write: boolean): boolean {
    let fresh = this.shown < sent;
    if (write) {
      fresh = fresh && this.newestWrite < sent;
      this.newestWrite = Math.max(this.newestWrite, sent);
      this.answeredAt = ++this.clock;
    } else {
      fresh = fresh && this.answeredAt < sent;
    }
    if (fresh) this.shown = sent;
    return fresh;
  }
}
