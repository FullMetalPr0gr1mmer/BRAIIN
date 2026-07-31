# Security Exceptions Register

Documented, time-boxed exceptions to the engineering standard, per **CLAUDE.md §11** ("flag and propose … a documented exception with an owner and expiry"). The pillar order **Security > Performance > SEO > Scalability** is never _silently_ weakened — every deviation is recorded here with an owner, a justification, and an expiry, and is revisited on or before that date.

| ID      | Opened     | Owner                          | Expiry     | Status | Summary                                                                                   |
| ------- | ---------- | ------------------------------ | ---------- | ------ | ----------------------------------------------------------------------------------------- |
| EXC-001 | 2026-06-14 | Developer (tech@purecoffee.sa) | 2026-09-12 | Open   | `npm audit` high+ gate made advisory (non-blocking); shipped-deps **critical** still blocks |

---

## EXC-001 — Supply-chain `npm audit` high+ gate temporarily advisory

**Pillar:** 1 (Security) — CLAUDE.md §3 (Pillar 1) / §7; architecture §4.10.
**Opened:** 2026-06-14 · **Owner:** Developer (tech@purecoffee.sa) · **Expiry:** 2026-09-12 (90 days).

### What changed

The CI `supply-chain` job (`.github/workflows/ci.yml`) previously failed the build on `npm audit --audit-level=high`. It now runs two steps:

- **Blocking:** `npm audit --omit=dev --audit-level=critical` — production (shipped) deps, critical only.
- **Advisory (non-blocking, `continue-on-error`):** full `npm audit --audit-level=high` — still printed in the logs, does not fail the build.

### Why (justification)

`npm audit` currently reports **1 critical + 9 high** (27 total). Every high/critical is in **build / dev / test tooling that is not present in the deployed Cloudflare Worker bundle**:

- `vitest` (critical — UI-server arbitrary file read/exec): test-only devDependency.
- `esbuild`, `vite`, `@vitejs/plugin-react`: bundler / dev-server, build-time only.
- `wrangler`, `undici`, `miniflare`: CLI / local preview, dev-only.
- `tmp` (via `@lhci/cli`): Lighthouse CI, CI-only.
- `astro`, `@astrojs/cloudflare`, `@astrojs/react` are flagged **high only because they pull the above as transitive npm dependencies**; their own advisories are **moderate/low**: `astro` define:vars XSS (moderate, already mitigated by the no-`unsafe-inline` CSP), `astro` server-island replay (low), `@astrojs/cloudflare` image-binding SSRF (low).

The shipped Worker (output of `astro build`) contains none of the bundler / test / CLI packages, so residual production risk is low and is bounded by the blocking critical guard above.

### Why not fix now

The only remediation `npm audit` offers is a **breaking** upgrade to `astro@6` / `@astrojs/cloudflare@13` / `@astrojs/react@5` / `vitest@4`, which **requires Node ≥ 22.12**. The current baseline is Node 20 (CI `node-version: 20`, `engines >=20.3.0`, portable toolchain `.tools/node-v20.18.0`). That is a coordinated **Node 20→22 + Astro-6** migration affecting CI, every dev machine, the portable toolchain, and teammate onboarding — to be done deliberately, not mid-phase-1.

### Remediation plan (clears this exception)

1. Adopt Node 22 baseline (CI `node-version: 22`; `engines >=22.12`; refresh `.tools`).
2. Upgrade `astro`→6.x, `@astrojs/cloudflare`→13.x, `@astrojs/react`→latest, `vitest`→4.x, `@lhci/cli`→latest.
3. Verify `astro check` + `build` + tests on Astro 6; migrate any breaking config (adapter / env / i18n APIs).
4. Confirm `npm audit --audit-level=high` is clean, then **restore the blocking full high+ audit** (remove `continue-on-error` and the `--omit=dev` / critical split) in `ci.yml`, and close this entry.

### Revisit

On or before **2026-09-12**. If still unresolved, re-justify and set a new expiry — never extend silently.
