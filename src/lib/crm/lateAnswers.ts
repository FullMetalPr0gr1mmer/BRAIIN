// Late answers on the leads screens (C4 star race): an answer that left before a change was
// saved must not undo that change on screen. Small rules, pure and DOM-free so every order of
// events is a few lines of a unit test (tests/lib/lateAnswers.spec.ts); the islands only pass
// their fetches and setters in.
//
//   • ListWrites, for the list. Its row toggles (the star) are optimistic and the bulk bar's
//     actions change rows too. A list read (a search, a filter, a page) never overlaps a row
//     write: a write aborts the read in flight, so its answer is never used, and a read asked for
//     while a write is out is held. Once every write has answered, the list is read once more
//     when a read was aborted or held, two writes overlapped (answer order is not commit order:
//     the PATCH audits and resolves interests after its update), a write failed (it can fail
//     after its update committed) or a bulk action ran (it is not optimistic). That read's
//     answer is the truth.
//   • pressStar and rowWrite run one list write through those rules; starOutcome says what a
//     failed press came to once the read after it lands.
//   • Serial, for a lead's page. Every read and write of the row runs one after another, so
//     the row's answers arrive in send order and the newest sent is the last shown; the page is
//     busy (its versioned controls disabled) until the queue is empty, follow-up reads included,
//     so no change can leave with an old version. writeInTurn is one PATCH in that queue.
//   • Latest, for a reload that is not queued (a lead's timeline): a newer one aborts the older.
//   • withDeadline bounds every row write and every queued read (ROW_WAIT_MS), so one request
//     that never answers cannot hold the list's reads or a lead's queue for good. A timeout
//     counts as a failure, which already reads again.
//
// Nothing here holds a row or a field: no contact detail, budget or note passes through
// (CLAUDE.md §3). State is a few numbers, one controller and one promise: nothing grows.

/** How long a row write or a queued read may take before it counts as failed. */
export const ROW_WAIT_MS = 15_000;

/** What a timed-out request says (P-12: plain, true either way). */
export const TOO_SLOW = 'The server did not answer in time.';

/** A request that ran past its deadline. */
export class TooSlow extends Error {
  constructor() {
    super(TOO_SLOW);
    this.name = 'TooSlow';
  }
}

/**
 * Runs `send` with a signal that aborts after `ms`. Past the deadline it rejects with TooSlow,
 * whatever the fetch threw on abort (browsers differ). The timer is cleared once it settles.
 */
export async function withDeadline<T>(
  send: (signal: AbortSignal) => Promise<T>,
  ms: number = ROW_WAIT_MS,
): Promise<T> {
  const controller = new AbortController();
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    controller.abort();
  }, ms);
  try {
    return await Promise.race([
      send(controller.signal),
      // A send that ignores its signal still lets go at the deadline.
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new TooSlow()), { once: true }),
      ),
    ]);
  } catch (err) {
    throw late ? new TooSlow() : err;
  } finally {
    clearTimeout(timer);
  }
}

export class ListWrites {
  /** The list read in flight, if any. */
  private reading: AbortController | null = null;
  /** Row writes not answered yet. */
  private out = 0;
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

  /**
   * A row write leaves (a toggle, a bulk action). It aborts the read in flight; and when
   * another write is still out, which of the two the server ran last is unknown (answer order
   * is not commit order), so the list is read once they have both answered.
   */
  write(): void {
    if (this.reading) {
      this.reading.abort();
      this.reading = null;
      this.again = true;
    }
    if (this.out > 0) this.again = true;
    this.out += 1;
  }

  /**
   * A write answered. `shown`: it succeeded and the screen already shows what it wrote (an
   * optimistic toggle). True when every write has answered and the list must be read now.
   */
  written(shown: boolean): boolean {
    this.out = Math.max(0, this.out - 1);
    if (!shown) this.again = true;
    if (this.out > 0 || !this.again) return false;
    this.again = false;
    return true;
  }
}

/** What one star press on the list needs from the island. */
export interface StarSteps {
  /** Draws the row's star: the press, or the value before it once the save failed. */
  show(on: boolean): void;
  /** Sends the PATCH. */
  send(signal: AbortSignal): Promise<unknown>;
  /** The save failed (or timed out): say so. The read after the writes says what is stored. */
  failed(err: unknown): void;
  /** Reads the list again. */
  reread(): void;
}

/**
 * One star press, as a row write. Shown at once. A failed save is drawn back (most failures
 * never reached the database) and the list is read again, since the PATCH can fail after its
 * update committed: that read, not the guess, is what the screen ends on. Resolves to whether
 * the save answered as saved.
 */
export async function pressStar(
  writes: ListWrites,
  next: boolean,
  steps: StarSteps,
  ms: number = ROW_WAIT_MS,
): Promise<boolean> {
  writes.write();
  steps.show(next);
  let ok = true;
  try {
    await withDeadline((signal) => steps.send(signal), ms);
  } catch (err) {
    ok = false;
    steps.show(!next);
    steps.failed(err);
  }
  if (writes.written(ok)) steps.reread();
  return ok;
}

/** One row write that is not optimistic (a bulk action): the list is read again after it. */
export async function rowWrite<T>(
  writes: ListWrites,
  send: (signal: AbortSignal) => Promise<T>,
  reread: () => void,
  ms: number = ROW_WAIT_MS,
): Promise<T> {
  writes.write();
  try {
    return await withDeadline(send, ms);
  } finally {
    if (writes.written(false)) reread();
  }
}

/** A failed star press waiting for the read after it. */
export interface StarCheck {
  id: string;
  /** Who, as the list names them. */
  name: string;
  /** What the press asked for. */
  next: boolean;
  /** Why the save failed, as said. */
  detail: string;
}

/** The words for a failed press, before the read after it has said what is stored. */
export function starPending(check: StarCheck): string {
  return `${check.name} may not be ${check.next ? 'starred' : 'unstarred'}. ${check.detail} Checking the list again.`;
}

/**
 * What a failed press came to once a read after it landed: '' when the read shows it saved
 * after all; that it could not be saved when the read shows the old value; that it could not be
 * confirmed when the read did not answer or the row is not on the page read.
 */
export function starOutcome(check: StarCheck, stored: boolean | undefined): string {
  const verb = check.next ? 'starred' : 'unstarred';
  if (stored === check.next) return '';
  if (stored === undefined) {
    return `${check.name} may not be ${verb}: the list could not confirm it. ${check.detail}`;
  }
  return `${check.name} could not be ${verb}. ${check.detail}`;
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

/** One PATCH on a lead's page, as the page wires it. */
export interface TurnSteps<T> {
  send(signal: AbortSignal): Promise<T>;
  /** The answer is the row as saved. */
  saved(answer: T): void;
  /** Says why it failed (a 409, a timeout, anything). True: the read after it keeps quiet. */
  refused(err: unknown): boolean;
  /** Reads the lead again (bounded, never rejects): `quiet` keeps a write's error up. */
  reread(quiet: boolean): Promise<void>;
}

/**
 * One PATCH in the lead page's queue, bounded by ROW_WAIT_MS. Any failure, a 409 or not, reads
 * the lead again inside the same turn (the PATCH may have committed before it failed), so the
 * page stays busy until that read lands. Resolves to whether it saved.
 */
export function writeInTurn<T>(
  queue: Serial,
  steps: TurnSteps<T>,
  ms: number = ROW_WAIT_MS,
): Promise<boolean> {
  return queue.run(async () => {
    try {
      steps.saved(await withDeadline((signal) => steps.send(signal), ms));
      return true;
    } catch (err) {
      const quiet = steps.refused(err);
      await steps.reread(quiet).catch(() => undefined);
      return false;
    }
  });
}

/** The newest of a reload that is not queued: asking again aborts the one still out. */
export class Latest {
  private current: AbortController | null = null;

  /** A new reload leaves: its controller (the one before it is aborted, its answer dropped). */
  next(): AbortController {
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    return controller;
  }
}
