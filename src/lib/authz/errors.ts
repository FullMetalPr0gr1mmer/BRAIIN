/** Thrown by the secondary authz layer (assertCap). Maps to HTTP 403. */
export class AuthorizationError extends Error {
  readonly status = 403 as const;
  constructor(
    readonly capability: string,
    readonly reason: string,
  ) {
    super(`Forbidden: missing capability '${capability}' (${reason})`);
    this.name = 'AuthorizationError';
  }
}
