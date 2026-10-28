import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import BaseLayout from '@/layouts/BaseLayout.astro';
import { PUBLIC_SITE_URL } from '../stubs/astro-env-client';
import { IDENTITY } from './fixtures';
import { normalise } from './harness';

// BaseLayout rendered whole (src/layouts/BaseLayout.astro) for the render project's specs: a
// fixed page in its slot, the fixture identity, any other request locals a spec passes, the
// checkout path and the site's origin normalised away (the snapshots name no hostname).

const scrub = (html: string) => normalise(html).split(PUBLIC_SITE_URL).join('<site>');

export async function renderLayout(
  props: Record<string, unknown>,
  locals: Partial<App.Locals> = {},
): Promise<string> {
  const container = await AstroContainer.create();
  const html = await container.renderToString(BaseLayout, {
    props,
    slots: { default: '<main><h1>Page</h1></main>' },
    request: new Request('https://www.example.test/'),
    locals: { identity: Promise.resolve(IDENTITY), ...locals } as App.Locals,
  });
  return scrub(html);
}

/** The pages the layout specs render: both languages, both headers, with and without chrome. */
export const LAYOUT_CASES = {
  'home, English': { title: 'Home', description: 'A studio.', locale: 'en', logicalPath: '/' },
  'home, Arabic': { title: 'الرئيسية', description: 'استوديو.', locale: 'ar', logicalPath: '/' },
  'about, English, overlay header': {
    title: 'About',
    description: 'Who.',
    locale: 'en',
    logicalPath: '/about',
    header: 'overlay',
  },
  'privacy, Arabic, no chrome': {
    title: 'الخصوصية',
    description: '',
    locale: 'ar',
    logicalPath: '/privacy',
    chrome: false,
  },
} as const;
