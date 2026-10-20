import PagesTab from './PagesTab';
import RedirectsTab from './RedirectsTab';
import SiteWideForm from './SiteWideForm';
import type { SeoListPage, SeoView } from './types';

// /admin/seo's island (Admin v2 U10): the page is server-rendered with in-page tabs
// (src/pages/admin/seo.astro decides who may open which), and hydrates this with the one
// view it shows. Pages arrives with its first page of rows already read on the server.

export type SeoScreenProps =
  | { view: 'pages'; initial: SeoListPage; canAdvanced: boolean }
  | { view: Exclude<SeoView, 'pages'> };

export default function SeoScreen(props: SeoScreenProps) {
  if (props.view === 'pages') {
    return <PagesTab initial={props.initial} canAdvanced={props.canAdvanced} />;
  }
  if (props.view === 'redirects') return <RedirectsTab />;
  return <SiteWideForm />;
}
