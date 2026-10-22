// The General screen's island props (Admin v2 U9), computed by src/pages/admin/settings.astro.

export interface GeneralScreenProps {
  /** The bundled white logo through `/_image` (the Brand card's read-only tiles). */
  logoSrc: string | null;
  /** Admin only (applications.manage): the job-applications switch is live for them. */
  canOpenApplications: boolean;
  /** The studio's time zone ("Saved at 14:05" in it). */
  tz: string;
}
