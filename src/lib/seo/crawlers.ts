// ─────────────────────────────────────────────────────────────────────────────
// CODE-OWNED AI-CRAWLER POLICY (CLAUDE.md Pillar 3)
// This single map is the source of truth for THREE things, kept in sync by a CI
// snapshot test:
//   1) the generated /robots.txt           (src/pages/robots.txt.ts)
//   2) the Cloudflare WAF training-deny rule (infra; same token set)
//   3) the /llms.txt index                  (src/pages/llms.txt.ts)
//
// Three tiers (a single robots rule cannot make these distinct decisions):
//   TRAINING   → Disallow: /     (don't feed model training without consent)
//   RETRIEVAL  → Allow            (citation/answer-engine surface — we WANT this)
//   USER-FETCH → Allow            (a human asked an assistant to fetch the page)
// ─────────────────────────────────────────────────────────────────────────────

/** Training crawlers — denied site-wide (also enforced at the WAF). */
export const TRAINING_DENY = [
  'GPTBot',
  'ClaudeBot',
  'Google-Extended',
  'CCBot',
  'Applebot-Extended',
  'Meta-ExternalAgent',
] as const;

/** Retrieval / citation crawlers — allowed (this is the AEO/GEO citation surface). */
export const RETRIEVAL_ALLOW = [
  'OAI-SearchBot',
  'Claude-SearchBot',
  'PerplexityBot',
  'Bingbot',
] as const;

/** User-triggered fetchers — allowed (a person asked an assistant to read this page). */
export const USER_FETCH_ALLOW = ['ChatGPT-User', 'Claude-User'] as const;

export type TrainingAgent = (typeof TRAINING_DENY)[number];
export type RetrievalAgent = (typeof RETRIEVAL_ALLOW)[number];
export type UserFetchAgent = (typeof USER_FETCH_ALLOW)[number];
