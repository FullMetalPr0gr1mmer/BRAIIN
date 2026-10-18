import { meterBucket, storageText } from './libraryState';

// "Storage used: 214 MB of 1 GB" (Admin v2 U4): the words, and the design system's bar
// (`.bar-fill[data-width]`, a 5% bucket: a style attribute would be refused by the CSP).
// The quota is the Supabase Free plan's 1 GB, which the media bucket shares with the job
// applications' CVs (D13, owner to confirm); the count is the media bucket's own files.

export interface StorageMeterProps {
  bytes: number;
  quotaBytes: number;
}

export default function StorageMeter({ bytes, quotaBytes }: StorageMeterProps) {
  const text = storageText(bytes, quotaBytes);
  return (
    <div className="media-meter">
      <span className="media-meter__t">{text}</span>
      <span className="bar" aria-hidden="true">
        <span className="bar-fill" data-width={meterBucket(bytes, quotaBytes)} />
      </span>
    </div>
  );
}
