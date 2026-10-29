// Late answers on the leads screens (C4 star race): an answer that left before a change was
// saved must not undo that change on screen. Two small rules, one per screen, both pure and
// DOM-free so every order of events is a few lines of a unit test (tests/lib/lateAnswers.spec.ts).
//
//   • ListWrites, for the list. Its row toggles (the star) are optimistic and the bulk bar's
//     actions change rows too. A list read (a search, a filter, a page) never overlaps a row
//     write: a write aborts the read in flight, so its answer is never used, and a read asked for
//     while a write is out is held. Once every write has answered, the list is read once more
//     when a read was aborted or held, an answer came back out of send order, a write failed
//     (the PATCH can fail after its update committed) or a bulk action ran (it is not
//     optimistic). Until that read lands the screen keeps what it shows; its answer is the truth.
//   • Serial, for a lead's page. Every read and write of the row runs one after another, so
//     answers arrive in send order and the newest sent is always the last shown; the page is
//     busy (its versioned controls disabled) until the queue is empty, follow-up reads included,
//     so no change can leave with an old version.
//
// Nothing here holds a row or a field: no contact detail, budget or note passes through
// (CLAUDE.md §3). State is a few numbers, one controller and one promise: nothing grows.

export class ListWrites {
  /** The list read in flight, if any. */
  private reading: AbortController | null = null;
  /** Row writes sent so far: each write's token is its place in send order. */
  private sent = 0;
  /** Row writes not answered yet. */
  private out = 0;
  /** The newest token answered so far. */
  private newest = 0;
  /** Read the list once every write has answered. */
  private again = false;

  /**
   * A list read wants to leave. Returns its controller (pass its signal to the fetch), or null
   * while a row write is out: the read is held, and asked for again once they have answered.
   */
  read(): AbortController | null {
    if (this.out > 0) {
      this.again = true;
      return null;
    }
    const controller = new AbortController();
    this.reading = controller;
    return controller;
  }

  /** A read's answer or failure arrived. False: it was aborted, so drop it unused. */
  landed(controller: AbortController): boolean {
    if (this.reading === controller) this.reading = null;
    return !controller.signal.aborted;
  }

  /** A row write leaves (a toggle, a bulk action). It aborts the read in flight. */
  write(): number {
    if (this.reading) {
      this.reading.abort();
      this.reading = null;
      this.again = true;
    }
    this.out += 1;
    this.sent += 1;
    return this.sent;
  }

  /**
   * A write answered. `shown`: it succeeded and the screen already shows what it wrote (an
   * optimistic toggle). True when every write has answered and the list must be read now.
   */
  written(token: number, shown: boolean): boolean {
    this.out = Math.max(0, this.out - 1);
    if (!shown || token < this.newest) this.again = true;
    this.newest = Math.max(this.newest, token);
    if (this.out > 0 || !this.again) return false;
    this.again = false;
    return true;
  }
}

export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  private out = 0;

  /** `busy` is told true when the first task is queued, false when the last has settled. */
  constructor(private readonly busy: (on: boolean) => void) {}

  /** Runs `task` once every task queued before it has settled; its answer is the task's. */
  run<T>(task: () => Promise<T>): Promise<T> {
    this.out += 1;
    if (this.out === 1) this.busy(true);
    const done = this.tail.then(task);
    const release = () => {
      this.out -= 1;
      if (this.out === 0) this.busy(false);
    };
    this.tail = done.then(release, release);
    return done;
  }
}
