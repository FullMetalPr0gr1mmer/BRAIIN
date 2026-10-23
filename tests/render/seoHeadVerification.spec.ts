import { describe, expect, test } from 'vitest';
import SeoHead from '@/components/SeoHead.astro';
import { PUBLIC_SITE_URL } from '../stubs/astro-env-client';
import { renderComponent } from './harness';

// The public <head> (src/components/SeoHead.astro), rendered to the byte (the F6 method). The
// snapshot was written by SeoHead as it stood BEFORE Admin v2 U11 taught it the Search Console
// verification tag, so it is the proof that a site with no token set serves the head it always
// did, on the home pages and everywhere else.

/** The site's origin, out of the stored output (the snapshot names no hostname). */
const scrub = (html: string) => html.split(PUBLIC_SITE_URL).join('<site>');

const CASES = {
  'home, English': { title: 'Home', description: 'A studio.', locale: 'en', logicalPath: '/' },
  'home, Arabic': { title: 'الرئيسية', description: 'استوديو.', locale: 'ar', logicalPath: '/' },
  'about, English': { title: 'About', description: 'Who.', locale: 'en', logicalPath: '/about' },
  'about, Arabic': { title: 'من نحن', description: 'من.', locale: 'ar', logicalPath: '/about' },
  'home, noindex': {
    title: 'Home',
    description: '',
    locale: 'en',
    logicalPath: '/',
    robots: 'noindex,follow',
  },
  'search, noindex': {
    title: 'Search',
    description: '',
    locale: 'en',
    logicalPath: '/search',
    robots: 'noindex,follow',
  },
} as const;

describe('the public head, to the byte, with no verification token', () => {
  test.each(Object.keys(CASES))('%s', async (name) => {
    const html = await renderComponent(SeoHead, { ...CASES[name as keyof typeof CASES] });
    expect(scrub(html)).toMatchSnapshot();
  });
});
