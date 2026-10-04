// Stub for the `astro:middleware` virtual module, which only exists inside the Astro
// build. Same reasoning as the `cloudflare:workers` stub beside it: without one,
// src/middleware.ts — the primary security enforcement point — cannot be imported by a
// unit test at all, so its ordering rules (maintenance before cache, redirects only
// after a 404, headers on every exit) were guarded by reading it carefully.
//
// `defineMiddleware` is an identity function in Astro too (it exists for type
// inference), so the stub changes nothing about how the handler runs.

type Handler = (context: unknown, next: () => Promise<Response>) => Promise<Response>;

export const defineMiddleware = (fn: Handler): Handler => fn;

/** Astro's `sequence`: each handler's `next` runs the following one. */
export function sequence(...handlers: Handler[]): Handler {
  return async (context, next) => {
    const run = async (index: number): Promise<Response> => {
      const handler = handlers[index];
      if (!handler) return next();
      return handler(context, () => run(index + 1));
    };
    return run(0);
  };
}
