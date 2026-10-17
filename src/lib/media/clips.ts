// The site's own video files, with their lengths (Admin v2 F5b, ui.md §2.6 "clip v2").
//
// A clip field stores a WINDOW of one of these (`/media/….mp4` plus a start and an end,
// EXC-009 until Stream lands — KAN-20), and an editor can only pick a sensible window if
// the form knows how long the file is. Code-owned, not a table: these files ship in
// `public/media/`, so a row could name one that is not there and a file could arrive with
// no row. tests/lib/siteClips.spec.ts reads each file's `mvhd` box and holds `durationS`
// to the file itself, so a replaced showreel that nobody re-measured fails CI rather than
// offering windows past the end of the video.
//
// Small and dependency-free on purpose: it ships in the admin bundle (admin-fields).

export interface SiteClip {
  /** The path stored in a clip's `path` (VideoClipSchema's StaticVideoPathSchema). */
  path: string;
  /** What an editor sees in the picker and in the clip's summary line. */
  name: string;
  /** The file's length in seconds, as its container states it. */
  durationS: number;
}

export const SITE_CLIPS: readonly SiteClip[] = [
  { path: '/media/showreel.mp4', name: 'showreel.mp4', durationS: 18.389 },
];
