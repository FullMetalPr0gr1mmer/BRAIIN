import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import type { AstroComponentFactory } from 'astro/runtime/server/index.js';
import type { Locale } from '@schemas/primitives';
import SectionRenderer from '@/components/SectionRenderer.astro';
import type { SectionData } from '@/lib/sections/types';
import { IDENTITY } from './fixtures';

// Rendering for the render project's specs: Astro's container API, with the request's
// identity (getIdentity reads `locals.identity`) set to the fixture identity.

export const LOCALES: readonly Locale[] = ['en', 'ar'];

let container: Promise<AstroContainer> | undefined;

// The checkout's own path reaches the output through dev-mode URLs: image sources
// (`/@fs/<root>/…`, URL-encoded inside `/_image?href=`) and component scripts. It is the one
// thing that differs between machines, and between Windows (`/@fs/C:/…`) and Linux
// (`/@fs/home/…`), so it is replaced before the comparison.
const ROOT = process.cwd().replace(/\\/g, '/').replace(/\/$/, '');
const FS = `/@fs/${ROOT.replace(/^\//, '')}`;
const SWAPS: readonly (readonly [string, string])[] = [
  [encodeURIComponent(FS), `${encodeURIComponent('/@fs/')}<root>`],
  [FS, '/@fs/<root>'],
  [ROOT, '<root>'],
];
export const normalise = (html: string): string =>
  SWAPS.reduce((out, [from, to]) => out.split(from).join(to), html);

/** One component, rendered with `props`, its checkout path normalised away. */
export async function renderComponent(
  component: AstroComponentFactory,
  props: Record<string, unknown>,
): Promise<string> {
  container ??= AstroContainer.create();
  const html = await (
    await container
  ).renderToString(component, {
    props,
    locals: { identity: Promise.resolve(IDENTITY) } as App.Locals,
  });
  return normalise(html);
}

/**
 * Sections through SectionRenderer, the path a page takes. SectionBoundary swallows a
 * section that throws into an empty placeholder, so a render holding one fails here: a
 * snapshot of it would hold a broken section as the truth.
 */
export async function renderSections(sections: SectionData[], locale: Locale): Promise<string> {
  const html = await renderComponent(SectionRenderer, { locale, sections });
  if (html.includes('section-error')) {
    throw new Error(`a section failed to render: ${sections.map((s) => s.type).join(', ')}`);
  }
  return html;
}
