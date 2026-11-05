// The words of a save that landed (Admin v2 R14b, out of SaveStatus.tsx so a pure module can
// read them: the e2e specs that run in both modes take their copy from here, never a
// duplicated literal). A pending change (release mode, R12) says so: "Saved as an unpublished
// change"; a live save says "Saved". SaveStatus adds the time ("… at 14:05").

/** "Saved", or "Saved as an unpublished change" for a save made in release mode. */
export function savedWords(staged: boolean): string {
  return staged ? 'Saved as an unpublished change' : 'Saved';
}
