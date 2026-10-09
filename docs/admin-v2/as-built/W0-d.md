# W0-d: content seam and cron registry

Wave 0 slice (plan B1: the `contentClient()` seam and the cron job registry). A refactor: no
behaviour change, no migration. Public HTML, cache tags, API responses and the cron's log lines
are what they were.

PR: set at merge, with the ledger.

## What was built

### The content seam, `src/lib/data/source.ts`

- `contentClient()` is the one place a public content loader gets its Supabase client. It sits at
  the path releases.md §6.3 and R8 already name, so R8 extends this file instead of moving it.
- The 15 loaders under `src/lib/data/` (blog, certifications, disciplines, navigation,
  pageSections, portfolio, search, sectionMedia, seo, serviceCases, services, siteProfile,
  statistics, taxonomy, team) moved all 24 of their `anonClient()` calls to it, search's two RPCs
  (`search_content`, `search_suggest`) included. R8's overlay client answers those "not
  previewable" (releases.md §6.3).
- Today it returns exactly what `anonClient()` returns, the same memoised instance, so every
  public query is the one it was.
- The contract, in the file's header:
  - it is the anon client: the anon key under RLS, a visitor's view of the launch tenant;
  - it reads public content only; writes, admin reads and PII take the service client behind
    `assertCap`, or the staff session;
  - it is looked up as each query is built (`contentClient().from(…)`) and the builder is
    awaited. It is never kept in a module-level variable and never looked up inside a thenable's
    `then()`, so a loader hands a supabase-js builder no `.then()` callback.
- Why the last rule (verification.md, claim 11): R8 runs the preview inside an AsyncLocalStorage
  scope. A native promise reaction keeps that scope, so a loader called from a native promise's
  `.then()` is fine: `src/lib/seo/head.ts`, `src/lib/services/page.ts` and
  `src/lib/portfolio/casePage.ts` do this on every Tier A page, the service page and the case
  study. workerd carries the scope only partly into a thenable's `then()`, and a supabase-js
  builder is one.
- Anon-key uses left outside the seam, and why:
  - `src/lib/supabase/client.ts` defines `anonClient()`; only the seam calls it.
  - `src/lib/auth/session.ts` builds the staff session client: the anon key plus a signed-in
    person's JWT, so RLS sees their role. It never reads as a visitor, and R8's preview dataset
    reads live rows through it on purpose, so it stays out of the seam.
  - Nothing else used the anon key. Tenant resolution, consent, telemetry, system logs and the
    contact and apply forms use the service role. The four service-role modules under
    `src/lib/data/` (`leads`, `systemLog`, `telemetry`, `tenant`) are named sinks, not loaders:
    each writes, or finds the tenant a write lands in, server-side.
- The guard is `tests/lib/contentSource.spec.ts`. It reads code through `tests/lib/sourceScan.ts`,
  which parses TypeScript and JavaScript with the TypeScript parser, so a comment is never code and
  code is never a comment. Any other text file (an `.astro` page) is read whole, as words, so the
  scan can only over-report. The rules, each list exact and carrying its reasons:
  - only `client.ts` and `source.ts` name `anonClient`;
  - only `client.ts`, `server.ts` and `auth/session.ts` name `createClient`,
    `createServerClient`, `createBrowserClient` or `PUBLIC_SUPABASE_ANON_KEY`;
  - the 15 loaders are pinned by path: exactly these files call `contentClient()`, and each builds
    every query (`.from`, `.rpc`, `.schema`, `.channel`, `.storage`, `.functions`) on
    `contentClient()` itself;
  - every module under `src/lib/data/` that queries is a loader or one of the four sinks, and only
    the sinks name `serviceClient`;
  - no `contentClient()` at module load, and no `.then()`, `.catch()` or `.finally()` on a builder
    made from it.

### The cron registry, `src/lib/cron/jobs.ts`

- `DAILY_JOBS` is an ordered array of `CronJob { name, label, budget, run }`:
  - `name`: its log lines carry `source: 'cron:<name>'`;
  - `label`: the failure line reads "`<label>` failed" when a job throws something that is not an
    Error;
  - `budget`: its worst case in subrequests, its own log lines included (a line costs two, the
    tenant lookup and the insert);
  - `run`: the job, which logs what it did itself.
- Three entries, in this order, their bodies moved verbatim from `daily.ts`: `privileged-ops`
  (the ledger purge, budget 1 + 2), `retention` (the Join retention, 6 + 2) and `crm-index` (the
  lead indexing, 2 + `INDEX_BATCH` + 2, which is 24 at 20 leads). 35 of the Free plan's 50.
  `indexLogEntry` and `PRIVILEGED_OPS_KEEP_MS` moved with them.
- `budget` is required, not optional: the 50 subrequests cap the whole run, so one job without a
  budget would leave the sum unknown.
- `src/lib/cron/daily.ts` runs the registry: the same Supabase-configured gate, then each job in
  order inside its own try/catch. A throw is logged under `cron:<name>` with the error's message,
  which is each old block's failure line exactly. `runDailyJobs(jobs = DAILY_JOBS)` takes the list
  so a test can run one job alone; the Worker calls it without one.
- `src/worker.ts`: only the `scheduled` comment changed. It points at the registry instead of
  listing the jobs, so adding a job never edits the Worker entry.
- `tests/lib/dailyJobs.spec.ts` pins the names in order, checks one line per job under its own
  name, runs each job at its worst (both CV removals, the country lookup) against its budget,
  holds the sum under 50 and isolates a throwing job. `tests/lib/crmIndexBackfill.spec.ts` reads
  its Free-plan sum from the registry instead of a hand-copied total.

### CLAUDE.md

Two sentences name the new modules where they state the rule:

- §8 Rendering & data flow: "Content Layer loaders use the anon key under RLS
  (`status='published'`, tenant-scoped), reached only through `contentClient()`
  (`src/lib/data/source.ts`, the seam the releases preview extends), never `anonClient()` directly
  (`tests/lib/contentSource.spec.ts`)."
- §10: the daily cron "runs the jobs registered in `src/lib/cron/jobs.ts`, in order and each
  within a declared subrequest budget (`tests/lib/dailyJobs.spec.ts`)".

## Departures from the brief, and why

- **No AsyncLocalStorage scope yet.** releases.md describes `contentClient()` as scoped. Wave 0 is
  a refactor with byte-identical public HTML, so this slice ships the pass-through. R8 adds the
  scope to this file, and R9 the `/admin/preview` branch of `src/middleware.ts` that enters it
  (`withContentSource`).
- **A stricter guard than "a test forbids `anonClient()` elsewhere".** A name check alone let a
  loader build its own client with `createClient` and the anon key, or query through a client held
  in a variable, and a loader count (at least 15) let a loader leave unseen. The guard also pins
  the loaders, the client factories and the anon key, checks what each query is built on, and
  holds the lookup rule.
- **The comment stripper is a parser.** The first guard copied the regex stripper of
  `tests/lib/adminConventions.spec.ts`. It reads any `/*` as a block comment, even inside a string
  or a `//` comment, and blanked real code in at least six files (an import in
  `src/lib/client/clips.ts`, most of the CSP builder in `src/lib/http/securityHeaders.ts`).
  `adminConventions.spec.ts` still has that regex. It is W0-c's file, and it can switch to
  `tests/lib/sourceScan.ts`.
- **The lookup rule is the verified one.** The first draft said "never call it inside a `.then()`
  callback", which three shipped call sites already break, harmlessly. The rule now matches
  verification.md claim 11: never inside a thenable's `then()`; native promise callbacks are fine.
- **Three jobs, not four.** CLAUDE.md §10 names "the Join retention and the limiter sweep" as
  separate steps, but the limiter's old counters (`public_write_attempts`) are deleted inside the
  Join retention (`runApplicationRetention`, `src/lib/applications/retention.ts`) and counted on
  its one log line (`limiterRowsDeleted`). Splitting the sweep out would change that line and add
  another, which a refactor must not do, so it stays inside the job, as before the registry.

## Files

- New: `src/lib/data/source.ts`, `src/lib/cron/jobs.ts`, `tests/lib/contentSource.spec.ts`,
  `tests/lib/sourceScan.ts`.
- Changed: the 15 loaders in `src/lib/data/`, `src/lib/cron/daily.ts`, the cron comment in
  `src/worker.ts`, `tests/lib/dailyJobs.spec.ts`.
- Outside the slice's own files: `src/lib/crm/indexBackfill.ts` (a comment pointed at `daily.ts`
  for the budget sum; it is `jobs.ts` now), `tests/lib/crmIndexBackfill.spec.ts` (its Free-plan sum
  reads the registry), CLAUDE.md (the two sentences above) and this note.
