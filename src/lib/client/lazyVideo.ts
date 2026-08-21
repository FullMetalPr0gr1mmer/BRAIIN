// Attaches a muted, looping background <video> to a container that declares
// `data-video-src`. The container's poster/backdrop paints first (it is the LCP
// candidate); video bytes only load when the caller decides — after `load` for the
// above-the-fold hero, on approach (IntersectionObserver) below the fold — so the
// "zero video bytes before intersection" budget holds (CLAUDE.md §6).
//
// Respects prefers-reduced-motion and Save-Data: those visitors keep the still poster.
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
  // Respect the sitewide motion toggle (WCAG 2.2.2): if the visitor paused motion
  // before this video mounted, it comes up showing its first frame, not playing.
  video.autoplay = !document.body.classList.contains('motion-paused');
  video.preload = 'auto';
  video.tabIndex = -1;
  video.setAttribute('aria-hidden', 'true');
  video.src = src;
  // `.has-video` cross-fades the poster out only once frames are actually decodable.
  video.addEventListener('canplay', () => container.classList.add('has-video'), { once: true });
  container.appendChild(video);
}
