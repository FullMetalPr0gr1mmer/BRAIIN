import ListRow from '@/components/admin/kit/ListRow';
import Note from '@/components/admin/kit/Note';
import { SITE_CLIPS } from '@/lib/media/clips';

// The Videos tab (Admin v2 U4): the site's own video files, read-only. Video is served from
// the site itself until Stream is set up (EXC-009, KAN-20), so a video is a file that ships
// with the site, not a library row, and cannot be uploaded here. No player: a list of names,
// paths and lengths keeps the screen light and sends no video bytes.

const seconds = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

export default function VideosTab() {
  return (
    <div className="media-videos">
      <Note>Videos are served from the site until video hosting is set up.</Note>
      <ul className="list" aria-label="Videos">
        {SITE_CLIPS.map((clip) => (
          <ListRow
            key={clip.path}
            icon="film"
            title={clip.name}
            sub={clip.path}
            meta={<span className="admin-sub">{`${seconds.format(clip.durationS)} s`}</span>}
          />
        ))}
      </ul>
    </div>
  );
}
