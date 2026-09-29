// Background-video manager for containers declaring `data-video-src`. The poster/
// backdrop paints first (LCP candidate); video bytes load only when the caller decides
// (post-`load` for the hero, on approach for below-fold sections), so the "zero video
// bytes before intersection" budget holds (CLAUDE.md §6).
//
// Same-src videos form a SYNC GROUP sharing one playback clock: the hero and the
// slogan band loop the same file today, and reaching the slogan should feel like the
// same video continuing, not restarting. Every pause snapshots the group clock; every
// play adopts it. Different sources simply play when their own section is on screen
// (sections report that through setVideoInView).
//
// Respects prefers-reduced-motion and Save-Data (no video at all — the still poster
// stays), and the sitewide WCAG 2.2.2 motion state (src/lib/client/motion.ts; no control
// ships today — EXC-007): while `body.motion-paused` is set nothing plays AND nothing mounts — a paused
// visitor downloads no video; surfaces that asked to mount meanwhile are mounted on
// resume, and only played if their section is still on screen.
//
// A container may play a WINDOW of its file (`data-clip-start` / `data-clip-end`, e.g. a
// banner hero on one showreel window): the loop seeks back to the start, and the sync
// group is keyed by file AND window — two windows of one file are different videos and
// must never adopt each other's clock.

import { clipWindow, seekTarget } from './clips';
import { isMotionPaused, onMotionChange } from './motion';

const groupTime = new Map<string, number>();
// Containers whose mount was asked for while motion was paused (mounted on resume).
const pending = new Set<HTMLElement>();

function videoOf(container: HTMLElement): HTMLVideoElement | null {
  return container.querySelector('video');
}

function record(video: HTMLVideoElement): void {
  const src = video.dataset.groupSrc;
  if (src) groupTime.set(src, video.currentTime);
}

function adopt(video: HTMLVideoElement): void {
  const src = video.dataset.groupSrc;
  const t = src === undefined ? undefined : groupTime.get(src);
  if (t !== undefined && Math.abs(video.currentTime - t) > 0.3) {
    try {
      video.currentTime = t;
    } catch {
      // not seekable yet — the loadedmetadata adopt below covers first play
    }
  }
}

function play(container: HTMLElement): void {
  const video = videoOf(container);
  if (!video || isMotionPaused()) return;
  adopt(video);
  void video.play().catch(() => {});
}

function pause(container: HTMLElement): void {
  const video = videoOf(container);
  if (!video) return;
  record(video);
  video.pause();
}

/**
 * Section scripts report whether their video surface is actually on screen (the hero's
 * cover state, the slogan pin's intersection); playback follows visibility and the
 * shared clock records/adopts on every transition. Safe to call before the video is
 * mounted — the flag is read again at mount time.
 */
export function setVideoInView(container: HTMLElement, inView: boolean): void {
  container.dataset.videoInView = inView ? '1' : '0';
  if (!inView) pause(container);
  // A mount deferred while paused, whose section arrives after the resume: mount now
  // (which plays it) rather than on the next global resume that may never come.
  else if (pending.has(container) && !isMotionPaused()) mountLazyVideo(container);
  else play(container);
}

// The sitewide motion state (motion.ts; no control ships today — EXC-007). Pause: every background video stops (the
// group clock is recorded by each one's `pause` listener). Resume: the mounts deferred
// meanwhile happen — only for surfaces still on screen; the others wait for their
// section (setVideoInView) — and the on-screen videos play again. Subscribed on first
// use, not at import: the module is also imported by unit tests with no `document`.
let motionBound = false;
function bindMotion(): void {
  if (motionBound) return;
  motionBound = true;
  onMotionChange((paused) => {
    for (const container of document.querySelectorAll<HTMLElement>('[data-video-src]')) {
      if (paused) pause(container);
      else if (container.dataset.videoInView !== '0') {
        if (pending.has(container)) mountLazyVideo(container);
        else play(container);
      }
    }
  });
}

export function mountLazyVideo(container: HTMLElement): void {
  bindMotion();
  if (container.querySelector('video')) return;
  const src = container.dataset.videoSrc;
  if (!src) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return;
  // Paused visitors download nothing: the mount waits for the resume (bindMotion above).
  if (isMotionPaused()) {
    pending.add(container);
    return;
  }
  pending.delete(container);

  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.tabIndex = -1;
  video.setAttribute('aria-hidden', 'true');
  const win = clipWindow(container);
  video.dataset.groupSrc = win ? `${src}#${win.start}-${win.end}` : src;
  if (win) {
    const loop = () => {
      const seekable = video.seekable.length > 0 ? video.seekable.end(0) : 0;
      const to = seekTarget(video.currentTime, win, seekable);
      if (to !== null) {
        try {
          video.currentTime = to;
        } catch {
          // not seekable yet — the next timeupdate retries
        }
      }
    };
    video.addEventListener('loadedmetadata', loop);
    video.addEventListener('timeupdate', loop);
  }
  video.src = src;
  // `.has-video` cross-fades the poster out only once frames are actually decodable.
  video.addEventListener('canplay', () => container.classList.add('has-video'), { once: true });
  // Seeking needs metadata; adopt the group clock as soon as it exists so a
  // later-mounting same-src video continues instead of restarting at 0.
  video.addEventListener('loadedmetadata', () => adopt(video), { once: true });
  // Snapshot the clock on every pause, whoever triggered it.
  video.addEventListener('pause', () => record(video));
  container.appendChild(video);

  if (container.dataset.videoInView !== '0' && !isMotionPaused()) {
    void video.play().catch(() => {});
  }
}
