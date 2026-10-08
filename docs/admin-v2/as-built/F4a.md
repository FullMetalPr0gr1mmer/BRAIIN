# F4a: the admin bundle plan

- **Lane:** UI, Phase 0 (F4 is split: F4a here, the component kit is F4b)
- **Design:** README "Slice sequence", F4 [AV-07]; [ui.md](../ui.md) AV-07
- **PR:** #40, folded into #34 (merged as `f690bc7` on 2026-10-08)
- **Migrations:** none

## Departures from the design, and why

F4 is split. **F4a** is the bundle plan: priority-ordered `codeSplitting` groups, the rich-text
editor lazy, a per-screen eager-graph gate (`scripts/admin-bundle.mjs`, run by `npm run size`).
Measured: every admin screen 225.5 → 103.9 KB gz eager, the sign-in script 168.4 → 2.2 KB, the
editor 122.2 KB on demand. Its first run caught Vite's preload helper captured into `admin-ui`
and imported by the public RUM script, now a neutral chunk. The size-limit sum stays the
tripwire (O-15 decides whether the per-screen measure replaces it). The kit's primitives (Kpi,
charts, DataTable, Sortable…) land with their first screens rather than ahead of them, the rule
F1 and F3 followed: charts and KPIs with Website stats (U2), DataTable and Sortable with the
first list that needs them. The groups keep Rolldown's default
`includeDependenciesRecursively: true`, not P-10's `false`: Rolldown's own docs pair `false`
with `strictExecutionOrder` and relaxed entry signatures to avoid invalid chunks, and with
`false` a dependency no group names (zod, the schemas) would land in an anonymously named chunk
that `.size-limit.json` weighs as public. So a group takes its modules' dependencies too, the
groups' priority order decides where a shared module lands, and `scripts/admin-bundle.mjs`
checks the outcome on every build.
