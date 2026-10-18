import type { ProbeView } from './probes';

// A reading as the JSON routes answer it (Admin v2 G2): `GET /api/admin/site-health`'s
// additive `uptime`, `domain` and `certificate` keys and Check now's answer. The state, when
// it was checked and last read well, and the parsed facts (Zod-bounded): nothing else.

export interface ProbeJson {
  state: ProbeView['state'];
  checkedAt: string | null;
  okAt: string | null;
  facts: ProbeView['facts'];
}

export function probeJson(view: ProbeView | null): ProbeJson | null {
  if (!view) return null;
  return { state: view.state, checkedAt: view.checkedAt, okAt: view.okAt, facts: view.facts };
}
