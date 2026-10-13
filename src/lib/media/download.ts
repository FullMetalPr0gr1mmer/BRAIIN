// The name an uploaded image is saved under when an editor downloads it (Admin v2 U3,
// GET /api/admin/media/[id]/download). What is stored is the re-encoded WebP master, so the
// upload's own name keeps its stem and takes `.webp`. The plain `filename` is ASCII only
// (quotes, slashes and control characters cannot survive into it); a name in Arabic, say,
// also travels as RFC 5987 `filename*`, which every current browser prefers.

/** RFC 5987: percent-encode everything but attr-char. */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The saved file's name: the upload's own name as WebP, or `media-<id>.webp`. */
function downloadName(displayName: unknown, id: string): { ascii: string; utf8: string | null } {
  const fallback = `media-${id.slice(0, 8)}`;
  const base =
    typeof displayName === 'string' ? displayName.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim() : '';
  const ascii =
    base
      .replace(/[^A-Za-z0-9._ -]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-. ]+|[-. ]+$/g, '')
      .slice(0, 80) || fallback;
  const utf8 = base && base !== ascii ? `${base.slice(0, 120)}.webp` : null;
  return { ascii: `${ascii}.webp`, utf8 };
}

/** The `Content-Disposition` of a download: always an attachment, never rendered inline. */
export function contentDisposition(displayName: unknown, id: string): string {
  const name = downloadName(displayName, id);
  return `attachment; filename="${name.ascii}"${
    name.utf8 ? `; filename*=UTF-8''${rfc5987(name.utf8)}` : ''
  }`;
}
