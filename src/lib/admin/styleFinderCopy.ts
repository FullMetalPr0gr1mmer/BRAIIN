// What the Style-Finder screens say about the quiz (Admin v2 U8a, D4): it is not on the site
// yet. /api/ai/style-finder is the 501 stub behind its rate limits and spend cap, nothing
// reads ai_questions, ai_styles or ai_config, and the AI service's key is a Worker secret.
// One module for the three server notes, so the words stay true together;
// tests/lib/styleFinderUi.spec.ts holds them to the stub.

/** Questions and Styles: publishing shows nothing anywhere yet. */
export const STYLE_FINDER_NOT_LIVE =
  'The Style-Finder is not on the site yet. What you publish here waits for the quiz and is shown nowhere.';

/** Results & logic: nothing here is read yet, and the key is never stored here. */
export const STYLE_FINDER_CONFIG_NOT_READ =
  'Nothing here is read yet. Until the quiz ships, every request to it is turned away and nothing is spent. The AI service’s key is a server secret and is never stored here.';
