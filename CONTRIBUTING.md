# Contributing to Braiin Station

Welcome. This project is built to a single, strict engineering standard. Read this once before your first change — it gets you **and your Claude Code** aligned with how we work.

## The prime directive

**[`CLAUDE.md`](./CLAUDE.md) is the authoritative engineering standard.** If code and that document disagree, the document wins until amended in a reviewed PR. Claude Code loads it automatically at the start of every session, so your assistant already knows the rules — your job is to hold the line on them.

Everything is judged against **four pillars, in strict priority order:**

> **1) Security → 2) Performance → 3) SEO/GEO/AEO → 4) Scalability.**

Higher pillar wins. Never weaken authz/CSP/consent to hit a perf budget — file an exception instead ([`CLAUDE.md`](./CLAUDE.md) §11).

No change is "done" until all **7 points** of the Definition of Done hold (`CLAUDE.md` §4): server-side authorized · within perf budget · server-rendered if indexable · accessible (WCAG 2.2 AA) · tested (incl. per-role authz) · observable · documented.

## First-time setup

1. **Clone & install**
   ```bash
   git clone https://github.com/FullMetalPr0gr1mmer/BRAIIN.git
   cd BRAIIN
   npm ci                 # pinned deps — do NOT use `npm install`
   cp .env.example .env   # fill per-environment values; NEVER commit .env
   ```
2. **Open Claude Code in the repo root** and **accept the workspace-trust dialog once.** This is required for the shared `.claude/` configuration (and the enforcement hooks we'll add later) to activate. Until you trust the folder, project config doesn't run.
3. Verify the shared config loaded: run `/memory` to confirm `CLAUDE.md` is listed, and `/permissions` to see the project allow/ask/deny rules.

## How Claude Code is set up for the team

Cloning the repo gives every developer's Claude the **same behavior** — by design, all under version control:

| File | What it does | Shared? |
|---|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | The authoritative standard, auto-loaded every session. | ✅ committed |
| `.claude/settings.json` | Permission guardrails — deny reading secret files (`.env*`, `.dev.vars`); hard-block force-push & `--no-verify`; prompt before `git push`, deploys, and `supabase db push`; commit/PR attribution trailers; bypass-permissions disabled. | ✅ committed |
| `.claude/rules/*.md` | Pillar-scoped reminders that load **only when you touch matching files** (e.g. editing a migration surfaces the RLS invariants). Each points back to the canonical `CLAUDE.md` section — no second source of truth. | ✅ committed |
| `.claude/settings.local.json` | Your personal overrides (machine paths, extra allows). | 🚫 gitignored |
| `CLAUDE.local.md` | Your personal project notes (sandbox URLs, test data). | 🚫 gitignored |

**Important nuance:** `CLAUDE.md` and the rules are *context* — Claude tries to follow them but compliance isn't mechanically guaranteed. Only the **permission rules** in `settings.json` (and the hooks below) are *hard enforcement*. Treat the standard as binding even where it isn't yet enforced by tooling.

### Personal config — never commit

`.claude/settings.local.json` and `CLAUDE.local.md` are gitignored — put machine-specific settings there. **Never** put secrets in `.claude/settings.json` (it's committed). Secrets live in Cloudflare Worker Secrets / Supabase Vault, declared type-safely via `astro:env`.

## Coming next: enforcement hooks

We will add committed **PreToolUse/PostToolUse hooks** (in `.claude/settings.json`) once the toolchain is installed (`npm ci`) and we agree on a cross-OS script form. Planned:

- **PostToolUse** on `Edit|Write` of `*.ts` → run `tsc --noEmit` + ESLint on changed files (enforces TS-strict).
- **PreToolUse** on `Edit|Write` matching `supabase/migrations/**` → block edits to already-applied migrations (forward-only rule).
- **Stop** → run the authz + schema-validation test gate.

Hooks are what turn "Claude *should* run the checks" into "the checks run regardless." Until then, run them manually (below).

## Conventions

- **Branches:** `phase-N/<topic>` for phase work (e.g. `phase-0/foundation`); `chore/…`, `fix/…` otherwise. Open PRs into `main`.
- **Migrations:** forward-only, expand/contract. Never edit an applied migration — add a new one.
- **Commits** end with the `Co-Authored-By` trailer; **PR bodies** end with the generated-with line — both applied automatically by the `attribution` block in `.claude/settings.json`. CI gate order follows pillar priority (`CLAUDE.md` §8).
- **Tests ship with the change.** Every sensitive op needs a per-role authz row over `admin, content_creator, seo, developer, anon, other_tenant` — `other_tenant` = deny on every row.

## Local commands

```bash
npm ci          # install pinned deps
npm run dev     # astro dev (public site + admin islands)
npm run check   # astro check + tsc --noEmit (strict)
npm run test    # unit + integration + per-role authz
npm run build   # production build (Cloudflare adapter)
```

## Where to read more

Start with the [README](./README.md) doc table → [`CLAUDE.md`](./CLAUDE.md), [`docs/architecture.md`](./docs/architecture.md), [`docs/delivery-plan.md`](./docs/delivery-plan.md). When in doubt, **flag and propose rather than ship something that fails a pillar** (`CLAUDE.md` §11).
