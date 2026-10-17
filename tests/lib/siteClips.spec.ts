import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SITE_CLIPS } from '@/lib/media/clips';
import { StaticVideoPathSchema } from '@schemas/media';

// The clip field offers windows of these files, so what the registry says about them must
// be what the files are. Each duration is checked against the file's own `mvhd` box (the
// movie header of an MP4), read here with a byte read — no new dependency (§3 supply
// chain). Replace the showreel without re-measuring it and this fails, rather than the
// editor offering a window past the end of the video.

const PUBLIC = join(process.cwd(), 'public');

/**
 * The duration an MP4 states, in seconds: `mvhd`'s timescale and duration, version 0
 * (32-bit) or 1 (64-bit). The box sits inside `moov`; finding it by its type is enough
 * here because the four letters are the box's own type field in every file we ship.
 */
function mp4Duration(file: string): number {
  const buf = readFileSync(file);
  const at = buf.indexOf(Buffer.from('mvhd', 'latin1'));
  expect(at, `${file} has no mvhd box`).toBeGreaterThan(0);
  const version = buf[at + 4];
  if (version === 1) {
    const timescale = buf.readUInt32BE(at + 24);
    return Number(buf.readBigUInt64BE(at + 28)) / timescale;
  }
  const timescale = buf.readUInt32BE(at + 16);
  return buf.readUInt32BE(at + 20) / timescale;
}

describe('the site clip registry (Admin v2 F5b)', () => {
  it('names at least the showreel', () => {
    expect(SITE_CLIPS.map((clip) => clip.path)).toContain('/media/showreel.mp4');
  });

  for (const clip of SITE_CLIPS) {
    describe(clip.path, () => {
      it('is a path the clip schema accepts, and the file is in public/', () => {
        expect(StaticVideoPathSchema.safeParse(clip.path).success).toBe(true);
        expect(existsSync(join(PUBLIC, clip.path.replace(/^\//, '')))).toBe(true);
      });

      it('is named after its file, and its length is the file’s own', () => {
        expect(clip.name).toBe(clip.path.split('/').pop());
        const measured = mp4Duration(join(PUBLIC, clip.path.replace(/^\//, '')));
        // Within a frame of the stated length: the registry rounds, the file does not.
        expect(Math.abs(clip.durationS - measured)).toBeLessThanOrEqual(0.05);
        expect(clip.durationS).toBeGreaterThan(0);
      });
    });
  }
});
