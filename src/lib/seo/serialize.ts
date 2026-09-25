// Serialises a value for embedding inside an HTML <script> element (JSON-LD, and any
// inline `application/json` data block).
//
// `JSON.stringify` is NOT safe for this on its own. It leaves `<`, `>` and `&` as-is, so a
// string containing `</script>` closes the element early and everything after it is parsed
// as markup. CSP stops an injected <script> from executing, but it does not stop injected
// markup: a `<meta http-equiv="refresh">`, a phishing `<form>`, or content that rewrites
// what a crawler indexes. Every CMS-authored string (testimonial quotes, client names,
// titles) reaches JSON-LD, so this is reachable by anyone with an editor login.
//
// The replacements below are the JSON-standard backslash-u escapes, so the output is still
// valid JSON with identical meaning: `JSON.parse(serializeForScript(x))` deep-equals `x`.
//   <, >  — the only characters that can form `</script`, `<!--` or `-->` in HTML
//   &     — defence in depth against entity-decoding contexts
//   U+2028 / U+2029 — legal in JSON strings but line terminators in pre-ES2019 JS
//
// The two separators are built with String.fromCharCode on purpose: written literally
// they are invisible, and inside a regex literal they are line terminators that break the
// parse — which is exactly how an editor round-trip can corrupt this file unnoticed.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const BACKSLASH_U = '\\u';

const ESCAPES = new Map<string, string>([
  ['<', `${BACKSLASH_U}003c`],
  ['>', `${BACKSLASH_U}003e`],
  ['&', `${BACKSLASH_U}0026`],
  [LS, `${BACKSLASH_U}2028`],
  [PS, `${BACKSLASH_U}2029`],
]);

const UNSAFE = new RegExp(`[<>&${LS}${PS}]`, 'g');

export function serializeForScript(value: unknown): string {
  const json = JSON.stringify(value);
  // JSON.stringify returns undefined for undefined/functions; embed `null` rather than
  // the literal text "undefined", which is not JSON.
  if (json === undefined) return 'null';
  return json.replace(UNSAFE, (ch) => ESCAPES.get(ch) ?? ch);
}
