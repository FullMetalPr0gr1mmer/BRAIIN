/** A concurrent edit won: the row's `version` no longer matches what the client held. */
export class OptimisticLockError extends Error {
  readonly status = 409 as const;
  constructor(readonly entity: string) {
    super(`Conflict: '${entity}' was modified by someone else`);
    this.name = 'OptimisticLockError';
  }
}

/** Row absent, or present but invisible to this caller's RLS — deliberately the same. */
export class NotFoundError extends Error {
  readonly status = 404 as const;
  constructor(readonly entity: string) {
    super(`Not found: ${entity}`);
    this.name = 'NotFoundError';
  }
}

/** Input the schema accepted but the domain rejects (duplicate slug, bad reference). */
export class ValidationError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly detail: string,
    readonly field?: string,
  ) {
    super(`Validation failed: ${detail}`);
    this.name = 'ValidationError';
  }
}

/** A rate limit or spend cap was hit (exports, AI proxy). */
export class RateLimitError extends Error {
  readonly status = 429 as const;
  constructor(readonly scope: string) {
    super(`Rate limit exceeded: ${scope}`);
    this.name = 'RateLimitError';
  }
}
