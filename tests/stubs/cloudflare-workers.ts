// Stub for the `cloudflare:workers` virtual module, which only exists inside workerd.
// Without it, any test that reaches a module importing Worker bindings fails to resolve
// rather than failing an assertion — and "cannot load url" reads like a broken test
// rather than the untested code path it actually is.
//
// The KV stand-in is an in-memory Map so the maintenance endpoint's write-through can be
// asserted rather than merely tolerated.

const store = new Map<string, string>();

export const env = {
  SESSION: {
    get: async (key: string): Promise<string | null> => store.get(key) ?? null,
    put: async (key: string, value: string): Promise<void> => {
      store.set(key, value);
    },
    delete: async (key: string): Promise<void> => {
      store.delete(key);
    },
  },
};

/** Test helper — lets a spec inspect or reset what the Worker wrote to KV. */
export const __kv = store;
