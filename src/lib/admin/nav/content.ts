import type { NavArea } from './types';

// Content: the site's pages, services, projects, posts and the collections they show.
export const content: NavArea = {
  title: 'Content',
  order: 20,
  links: [
    {
      href: '/admin/pages',
      label: 'Pages',
      icon: 'pages',
      caps: ['pages.write', 'seo.entityMeta'],
      match: ['/admin/sections'],
      tabs: [
        { href: '/admin/pages', label: 'Pages', caps: ['pages.write', 'seo.entityMeta'] },
        { href: '/admin/sections', label: 'Sections', caps: ['pages.write'] },
      ],
    },
    {
      href: '/admin/services',
      label: 'Services',
      icon: 'layers',
      caps: ['services.write', 'seo.entityMeta'],
      match: ['/admin/disciplines', '/admin/service-cases'],
      tabs: [
        {
          href: '/admin/services',
          label: 'Services',
          caps: ['services.write', 'seo.entityMeta'],
        },
        { href: '/admin/disciplines', label: 'Disciplines', caps: ['services.write'] },
        { href: '/admin/service-cases', label: 'Case studies', caps: ['services.write'] },
      ],
    },
    {
      href: '/admin/portfolio',
      label: 'Projects',
      icon: 'briefcase',
      caps: ['portfolio.write', 'seo.entityMeta'],
      match: ['/admin/sectors'],
      tabs: [
        {
          href: '/admin/portfolio',
          label: 'Projects',
          caps: ['portfolio.write', 'seo.entityMeta'],
        },
        { href: '/admin/sectors', label: 'Sectors', caps: ['categories.manage'] },
      ],
    },
    {
      href: '/admin/blog',
      label: 'Creative Knowledge',
      icon: 'type',
      caps: ['blog.write', 'seo.entityMeta'],
      match: ['/admin/categories'],
      tabs: [
        { href: '/admin/blog', label: 'Posts', caps: ['blog.write', 'seo.entityMeta'] },
        { href: '/admin/categories', label: 'Categories', caps: ['categories.manage'] },
      ],
    },
    {
      href: '/admin/testimonials',
      label: 'Testimonials',
      icon: 'quote',
      caps: ['portfolio.write'],
    },
    { href: '/admin/clients', label: 'Clients', icon: 'star', caps: ['portfolio.write'] },
    { href: '/admin/team', label: 'Team', icon: 'users', caps: ['blog.write'] },
    { href: '/admin/statistics', label: 'Numbers', icon: 'grid', caps: ['services.write'] },
    {
      href: '/admin/certifications',
      label: 'Certifications',
      icon: 'tag',
      caps: ['services.write'],
    },
    {
      href: '/admin/media',
      label: 'Media library',
      icon: 'image',
      caps: ['media.write'],
      access: ['full', 'meta'],
    },
  ],
};
