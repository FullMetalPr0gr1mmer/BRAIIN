// The site's own video files, with their lengths (Admin v2 U4; the shape F5b's clip v2 field
// defines, created here because U4 merged first: brief D14, whichever merges second
// resolves). Video is served from the site itself until Stream lands (EXC-009, KAN-20), so
// these files are not media_assets rows: the library's Videos tab lists them, read-only, and
// a clip field stores a window of one of them.
//
// Code-owned, not a table: the files ship in `public/media/`. Small and dependency-free: it
// ships in the admin bundle.

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
