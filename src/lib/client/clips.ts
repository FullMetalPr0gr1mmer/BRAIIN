// In-content video clips — MediaFrame (src/components/media/MediaFrame.astro). A frame
// ships only its poster; the <video> is created here on the first trigger, so a page
// carries zero video bytes until someone could actually see the clip (CLAUDE.md §6,
// tests/e2e/media-bytes.e2e.ts). Each frame plays a WINDOW of a file — the design plays
// short windows of one showreel on every card — looped by seeking back to its start.
//
//   data-clip-src      the file (a /media/*.mp4 path under EXC-009)
//   data-clip-start    window start, seconds (optional — omitted = the whole file)
//   data-clip-end      window end, seconds
//   data-clip-mode     "inview"  plays while at least `data-clip-threshold` of it is on
//                                screen (default .35), pauses when it leaves
//                      "hover"   plays while a mouse/pen pointer is over, or keyboard focus
//                                is in, the closest [data-clip-trigger] (the card link)
//   data-clip-after-load  inview only: not observed until `load` — the frame's poster is
//                      the LCP (About's "who"), so its clip's bytes never compete with it,
//                      the rule MediaBanner and the hero apply
//
// Never plays: under prefers-reduced-motion, with Save-Data, or on a touch-only device
// ("in-content clips never autoplay on touch" — design-port decision 1, a compensating
// control of EXC-009); the poster stays. Pauses with the page hidden, and while the
// sitewide motion switch is off (`body.motion-paused`, src/lib/client/motion.ts — the
// header's pause button): then no clip plays or even mounts, hover clips included (simpler
// and stricter than arguing a hover is user-initiated), and the frames that were wanted
// meanwhile play on resume. When a clip pauses the poster comes back (the mockup left the
// frozen video frame up and never restored its play badge). Every frame wired here gets
// .can-clip, which is what shows the play badge: no badge where nothing can play (touch,
// reduced motion, Save-Data, no JS).
//
// Deliberately separate from lazyVideo.ts's sync group: that keeps same-file BACKGROUND
// loops on one clock; clips are different windows of one file and must never adopt each
// other's position.

import { isMotionPaused, onMotionChange } from './motion';

export interface ClipWindow {
  start: number;
  end: number;
}

/** A frame's window, or null when it plays the whole file (or the attributes are bad). */
export function clipWindow(el: HTMLElement): ClipWindow | null {
  const start = Number(el.dataset.clipStart);
  const end = Number(el.dataset.clipEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || el.dataset.clipStart === undefined) {
    return null;
  }
  return end > start && start >= 0 ? { start, end } : null;
}

/**
 * Where to seek, if anywhere, for the current position — the loop of a window. Only when
 * the file is seekable far enough (a server without range support plays the whole file,
 * looping on its own, rather than stuttering at 0).
 */
export function seekTarget(
  currentTime: number,
  window: ClipWindow,
  seekableEnd: number,
): number | null {
  if (seekableEnd <= window.end - 0.1) return null;
  if (currentTime >= window.end || currentTime < window.start - 0.05) return window.start;
  return null;
}

/** Whether an in-view frame must wait for `load` before it is observed (its poster is the LCP). */
export function waitsForLoad(el: HTMLElement, readyState: DocumentReadyState): boolean {
  return el.dataset.clipAfterLoad !== undefined && readyState !== 'complete';
}

/** Whether clips may play at all in this environment. */
export function clipsAllowed(env: {
  reducedMotion: boolean;
  saveData: boolean;
  canHover: boolean;
}): boolean {
  return !env.reducedMotion && !env.saveData && env.canHover;
}

/**
 * Whether a pointer entering a hover trigger starts its clip. "(hover: hover)" describes
 * only the PRIMARY pointer: on a touchscreen laptop a finger landing on a card — or
 * starting a scroll across it — fires pointerenter too, and must not fetch the clip.
 */
export function hoverStartsClip(pointerType: string): boolean {
  return pointerType !== 'touch';
}

function environment() {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
  return {
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    saveData: nav.connection?.saveData === true,
    // "(hover: hover)" — a device whose primary pointer can hover. Touch-only is false.
    canHover: matchMedia('(hover: hover)').matches,
  };
}

const wanted = new WeakMap<HTMLElement, boolean>();

function ensureVideo(frame: HTMLElement): HTMLVideoElement | null {
  const existing = frame.querySelector<HTMLVideoElement>('video');
  if (existing) return existing;
  const src = frame.dataset.clipSrc;
  if (!src) return null;
  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.tabIndex = -1;
  video.setAttribute('aria-hidden', 'true');
  video.disableRemotePlayback = true;
  // The window is read from the frame on every tick, not captured here, so retargetClip()
  // can move a live frame to another window without recreating its <video>.
  const loop = () => {
    const win = clipWindow(frame);
    if (!win) return;
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
  video.addEventListener('playing', () => frame.classList.add('is-playing'));
  video.addEventListener('pause', () => frame.classList.remove('is-playing'));
  video.src = src;
  frame.appendChild(video);
  return video;
}

function play(frame: HTMLElement): void {
  wanted.set(frame, true);
  // `wanted` is recorded first, so a hidden tab or a paused visitor resumes into it.
  if (document.hidden || isMotionPaused()) return;
  const video = ensureVideo(frame);
  void video?.play().catch(() => {});
}

function pause(frame: HTMLElement): void {
  wanted.set(frame, false);
  frame.querySelector<HTMLVideoElement>('video')?.pause();
}

export interface ClipTarget {
  src: string;
  start?: number | undefined;
  end?: number | undefined;
}

/** Whether a frame's data attributes already name this clip (no retarget needed). */
export function sameClip(data: DOMStringMap, next: ClipTarget): boolean {
  const num = (v: number | undefined) => (v === undefined ? undefined : String(v));
  return (
    data.clipSrc === next.src &&
    data.clipStart === num(next.start) &&
    data.clipEnd === num(next.end)
  );
}

/**
 * Points a clip frame at another window (or file) — the /services explorer, whose panel
 * media follows the hovered service row. Before the frame's <video> exists this only
 * rewrites its attributes (the first play reads them). After, the poster shows (the video
 * fades out) while the video seeks, and the video fades back in once it has.
 */
export function retargetClip(frame: HTMLElement, next: ClipTarget): void {
  if (sameClip(frame.dataset, next)) return;
  frame.dataset.clipSrc = next.src;
  if (next.start === undefined) delete frame.dataset.clipStart;
  else frame.dataset.clipStart = String(next.start);
  if (next.end === undefined) delete frame.dataset.clipEnd;
  else frame.dataset.clipEnd = String(next.end);
  const video = frame.querySelector<HTMLVideoElement>('video');
  // Paused visitor: the attributes are rewritten (the resume's play() reads them and the
  // timeupdate loop seeks into the new window), but no src swap or seek — each is a fetch.
  if (!video || isMotionPaused()) return;
  frame.classList.remove('is-playing');
  video.addEventListener(
    'seeked',
    () => {
      if (!video.paused) frame.classList.add('is-playing');
    },
    { once: true },
  );
  if (video.getAttribute('src') !== next.src) {
    video.src = next.src; // a new file: `loadedmetadata` seeks into the window
  } else {
    const win = clipWindow(frame);
    try {
      video.currentTime = win ? win.start : 0;
    } catch {
      // not seekable yet — timeupdate brings it into the window
    }
  }
  if (wanted.get(frame) && !document.hidden && !isMotionPaused()) {
    void video.play().catch(() => {});
  }
}

let globalBound = false;
const frames = new Set<HTMLElement>();

// The two things that stop every clip at once: the tab going hidden, and the sitewide
// motion switch. Both resume only the frames still `wanted` (on screen / hovered) — and
// the switch resumes them through play(), which also creates the <video> a frame never
// got while paused.
function bindGlobal(): void {
  if (globalBound) return;
  globalBound = true;
  document.addEventListener('visibilitychange', () => {
    for (const frame of frames) {
      const video = frame.querySelector<HTMLVideoElement>('video');
      if (!video) continue;
      if (document.hidden) video.pause();
      else if (wanted.get(frame) && !isMotionPaused()) void video.play().catch(() => {});
    }
  });
  onMotionChange((paused) => {
    for (const frame of frames) {
      if (paused) frame.querySelector<HTMLVideoElement>('video')?.pause();
      else if (wanted.get(frame) && !document.hidden) play(frame);
    }
  });
}

/** Wires every clip frame under `root` (idempotent per frame). */
export function initClips(root: ParentNode = document): void {
  if (!clipsAllowed(environment())) return;
  bindGlobal();
  const inview = new Map<number, IntersectionObserver>();
  for (const frame of root.querySelectorAll<HTMLElement>('[data-clip-src]')) {
    if (frames.has(frame)) continue;
    frames.add(frame);
    frame.classList.add('can-clip');
    if (frame.dataset.clipMode === 'hover') {
      const trigger = frame.closest<HTMLElement>('[data-clip-trigger]') ?? frame;
      trigger.addEventListener('pointerenter', (e) => {
        if (hoverStartsClip(e.pointerType)) play(frame);
      });
      trigger.addEventListener('pointerleave', () => pause(frame));
      trigger.addEventListener('focusin', () => play(frame));
      trigger.addEventListener('focusout', () => pause(frame));
      continue;
    }
    const threshold = Number(frame.dataset.clipThreshold ?? '0.35');
    const key = Number.isFinite(threshold) ? threshold : 0.35;
    let io = inview.get(key);
    if (!io) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const target = e.target as HTMLElement;
            if (e.isIntersecting) play(target);
            else pause(target);
          }
        },
        { threshold: key },
      );
      inview.set(key, io);
    }
    if (waitsForLoad(frame, document.readyState)) {
      const observer = io;
      addEventListener('load', () => observer.observe(frame), { once: true });
    } else io.observe(frame);
  }
}
