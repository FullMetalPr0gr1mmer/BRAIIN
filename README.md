# Braiin Station

A production, single-platform creative-agency system: a bilingual (EN/AR, RTL) marketing/portfolio public site for 14 services, an AI Style-Finder lead-gen app (module boundary in v1), an SEO/GEO/AEO Creative Knowledge blog, and a role-gated admin/CMS — engineered against four pillars in strict priority order: **Security → Performance → SEO/GEO/AEO → Scalability.**

> **Status:** Phase 0 — Foundation (in progress). No feature code ships until it meets the 7-point Definition of Done in [`CLAUDE.md`](./CLAUDE.md).

## Stack

| Layer       | Choice                                                             |
| ----------- | ------------------------------------------------------------------ |
| Public site | Astro (static-first shell + Server Islands)                        |
| Admin       | React islands inside Astro                                         |
| Backend     | Supabase — Postgres, Auth, Edge Functions, Storage                 |
| Rich text   | Tiptap (sanitised JSON + derived HTML cache)                       |
| Hosting     | Cloudflare **Workers Builds** (Astro Cloudflare adapter)           |
| Video       | Cloudflare Stream                                                  |
| Language    | TypeScript `strict`; Zod as the single content/validation boundary |

## Documentation (read these first)

| Doc                                                                            | What it is                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)                                         | **Start here (new teammates).** First-time setup, how Claude Code is configured for the team, conventions, and the Definition-of-Done gate.                            |
| [`CLAUDE.md`](./CLAUDE.md)                                                     | **The engineering standard.** Conventions, four pillars, role×permission matrix, performance budgets, Definition of Done. If code and this doc disagree, the doc wins. |
| [`docs/architecture.md`](./docs/architecture.md)                               | How the system is engineered to survive production — rendering, data model, auth/RBAC, security, performance, video, SEO, scalability, CI/DR.                          |
| [`docs/delivery-plan.md`](./docs/delivery-plan.md)                             | The phased plan (Foundation → Public site → Blog → Admin/CMS → AI Style-Finder), each phase gated on the Definition of Done.                                           |
| [`braiin-station-feature-inventory.md`](./braiin-station-feature-inventory.md) | Source brief — what the system does.                                                                                                                                   |
| [`braiin-station-analysis.md`](./braiin-station-analysis.md)                   | Source brief — the gap report (the "why" behind the requirements).                                                                                                     |

## Project layout (target)

```
src/
  middleware.ts          # security headers + CSP nonce + redirects + maintenance pre-cache
  lib/authz/matrix.ts    # ROLE_CAPS (single source of truth; CI snapshot-asserted)
  layouts/  components/  pages/   # SeoHead, JsonLd, SectionRenderer, StreamPlayer, ...
packages/
  schemas/               # Zod shapes shared by site, admin, Edge Functions
  consent/gate.ts        # the single hasConsent(category) PDPL gate
supabase/
  migrations/            # forward-only; tenant_id + RLS (enable+force) on every table
  functions/             # Edge Functions (JWT-verified, assertCap)
tests/
  authz/                 # per-role authz matrix + pgTAP RLS
.github/workflows/       # pillar-ordered CI gates
```

## Local development

> **New here?** Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first — it covers team setup and how Claude Code is configured for consistency across developers.
>
> **Prerequisite:** Node.js LTS (≥ 20) + a package manager. The scaffold is committed but not yet installed/built in CI.

```bash
npm ci                  # install pinned deps
npm run dev             # astro dev (public site + admin islands)
npm run check           # astro check + tsc --noEmit (strict)
npm run test            # unit + integration + per-role authz
npm run build           # production build (Cloudflare adapter)
```

Environment variables are declared type-safely via `astro:env` (see `astro.config.mjs`). Copy `.env.example` to `.env` and fill per-environment values. **Never commit secrets** — the Supabase service-role key, `ANTHROPIC_API_KEY`, and signing keys are server-only and live in Cloudflare Worker Secrets / Supabase Vault.

## License

Proprietary — © Braiin Station. All rights reserved.
