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
// stays), and the sitewide WCAG 2.2.2 motion toggle (setMotionPaused).

const groupTime = new Map<string, number>();

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

function motionPaused(): boolean {
  return document.body.classList.contains('motion-paused');
}

function play(container: HTMLElement): void {
  const video = videoOf(container);
  if (!video || motionPaused()) return;
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
  if (inView) play(container);
  else pause(container);
}

/**
 * The hero's WCAG 2.2.2 toggle: pauses every background video, resumes only the
 * on-screen ones. The CSS marquee pauses via the body class this sets.
 */
export function setMotionPaused(paused: boolean): void {
  document.body.classList.toggle('motion-paused', paused);
  for (const container of document.querySelectorAll<HTMLElement>('[data-video-src]')) {
    if (paused) pause(container);
    else if (container.dataset.videoInView !== '0') play(container);
  }
}

export function mountLazyVideo(container: HTMLElement): void {
  if (container.querySelector('video')) return;
  const src = container.dataset.videoSrc;
  if (!src) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return;

  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.tabIndex = -1;
  video.setAttribute('aria-hidden', 'true');
  video.dataset.groupSrc = src;
  video.src = src;
  // `.has-video` cross-fades the poster out only once frames are actually decodable.
  video.addEventListener('canplay', () => container.classList.add('has-video'), { once: true });
  // Seeking needs metadata; adopt the group clock as soon as it exists so a
  // later-mounting same-src video continues instead of restarting at 0.
  video.addEventListener('loadedmetadata', () => adopt(video), { once: true });
  // Snapshot the clock on every pause, whoever triggered it.
  video.addEventListener('pause', () => record(video));
  container.appendChild(video);

  if (container.dataset.videoInView !== '0' && !motionPaused()) {
    void video.play().catch(() => {});
  }
}
