# Braiin Station — Feature Inventory

**Braiin Station** is a creative agency website + platform. It pairs a marketing/portfolio public site with an authenticated CMS admin dashboard, an AI-powered style-discovery web app, and a content (blog) engine built for SEO/GEO/AEO ranking. Everything on the public site is dynamic and editable from the admin. The site is bilingual-ready and governed by four roles: **Admin, Content Creator, SEO, Developer**.

This inventory reuses proven features from the prior platform (CMS engine, media library, analytics, theming, scheduling, audit logging, etc.) and adapts them to Braiin Station's structure. Features carried over from the existing system are tagged **[reuse]**; features new to Braiin Station are tagged **[new]**.

**How to read the tables:** each feature has a plain-language description (for stakeholders) and a technical note (for developers). The **Role / Access** column is filled only where access differs by role; otherwise "—".

**The four roles at a glance:**
- **Admin** — full access to everything, including users, settings, and billing-level controls.
- **Content Creator** — creates/edits content (services, blog, portfolio, media); cannot manage users or core settings.
- **SEO** — manages SEO/GEO/AEO settings, metadata, schema, redirects, and reads analytics; limited content editing.
- **Developer** — full technical access plus an exclusive site-health/performance panel.

---

## Part 1: Public Site

### Home (`/`)

The agency landing page. Every section is CMS-driven, individually toggleable, and re-orderable, so the page composition is controlled entirely from the admin.

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Hero — logo art **[new]** | Opening hero featuring branded logo artwork with a primary button to Services. | CMS hero section variant `art`; CTA target editable. | — |
| Hero — portfolio video **[new]** | Alternative hero: a showreel/portfolio video instead of static art (admin chooses variant). | Hero variant `video`; multi-source player (file/YouTube/Vimeo) reused from existing video logic. | — |
| Clients animation strip **[new]** | Animated marquee/logos of clients the agency has worked with. | Reuse partner-logos data model (`partner_logos`) with per-logo scale/offset; add marquee animation. | — |
| Services overview **[new]** | Grid of all services with icon, title, short blurb, each linking to its service page. | CMS "services" section pulling from a `services` collection; dynamic icon mapping. | — |
| Call-to-action band **[reuse]** | Conversion band (e.g. "Start a project") with benefits and a button. | Reuse `cta_banner` section type. | — |
| Social media section **[reuse]** | Row/section of social platform links. | Reuse `social_links` model + social strip. | — |
| Section visibility & ordering **[reuse]** | Any home section can be hidden, shown, reordered, and styled from the admin. | Reuse page-section CMS engine (`page_sections`, visibility, style overrides). | — |
| Per-section error isolation **[reuse]** | One broken section won't take down the whole homepage. | Reuse section error boundaries. | — |
| SEO / structured data **[reuse]** | Meta tags + JSON-LD (Organization, WebSite) for rich search results. | Reuse `SEO` + `JsonLd` (`buildOrganizationSchema`, `buildWebSiteSchema`). | — |

### Services index (`/services`)

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Services listing **[new]** | Browse all 14 services as cards. | Reads `services` collection; CMS-managed order. | — |
| Filtering / grouping (optional) **[new]** | Group services by category (e.g. visual, digital, events). | Optional category field on `services`. | — |

### Service detail (`/services/:slug`) — one per service

Applies to all services: **Branding, Animations, Motion Graphics, Videography, Photography, Montage, Event Planning, Advertising, Social Media, Web Development, SEO & GEO & AEO, Music, Merchandise** (and **Gaming** — later).

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Service hero video **[new]** | Each service page opens with a hero video showcasing work in that field. | Per-service `hero_video` field; multi-source player reused. | — |
| Service details body **[new]** | Rich content describing the service, process, deliverables. | Rich-text (Tiptap) content block per service; bilingual-ready. | — |
| Linked portfolio / case studies **[new]** | Show related portfolio pieces for that service. | Relation between `services` and `portfolio` items. | — |
| Service-level CTA **[reuse]** | "Request this service" call-to-action → contact/inquiry. | Reuse CTA + lead-capture flow. | — |
| Per-service SEO/schema **[reuse]** | Each service page has its own meta + Service schema. | Reuse `SEO` + `buildServiceSchema`. | SEO role manages meta |
| "Coming later" state (Gaming) **[new]** | Gaming can be published as a teaser/"coming soon" without full content. | Service `status` supports draft/teaser/published. | — |

### AI Style-Finder web app (`/discover` or similar) **[new]** — *high-level (detail later)*

An interactive, AI-driven web app that walks clients through questions and design styles to help them discover their own style/direction.

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Guided style quiz | Question-by-question flow presenting design styles and options. | New module; question/style data CMS-managed (to be detailed). | — |
| Style library | A large catalog of design styles/visual references shown during the flow. | Styles stored as a managed collection (images + metadata). | Content Creator curates |
| AI-driven recommendation | Produces a personalized style result/summary from the user's answers. | AI inference layer (provider TBD); approach to be specified later. | — |
| Result → lead conversion | Turn a completed result into a contact/inquiry or saved lead. | Reuse lead-capture + analytics event. | — |
| Admin management | Add/edit questions, styles, and result logic from the dashboard. | New CMS module; specifics deferred. | Content Creator / Admin |

> **Note:** This app is intentionally scoped at a high level here. A dedicated spec (question model, AI approach, scoring/recommendation logic, data storage, costs) should follow.

### Creative Knowledge — Blog (`/creative-knowledge`)

The content engine built to rank on Google and AI answer engines, build credibility, and convert readers into clients.

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Article listing **[reuse]** | Paginated, category-filtered grid of articles. | Reuse blog listing + edge function `get-blog-posts`. | — |
| Article detail **[reuse]** | Full article with featured image, author, date, read time. | Reuse blog-post page. | — |
| Auto table of contents **[reuse]** | Clickable, scroll-synced TOC from headings. | Reuse `extractHeadings`/`injectHeadingIds`. | — |
| Key takeaways + speakable schema **[reuse]** | Summary bullets with AEO-friendly speakable markup. | Reuse takeaways + `SpeakableSpecification` JSON-LD. | — |
| FAQ accordion + FAQ schema **[reuse]** | Per-article Q&A with structured data (strong for AEO/GEO). | Reuse FAQ blocks + `buildFAQSchema`. | — |
| Author box + credibility **[reuse]** | Author bio to build E-E-A-T/credibility. | Reuse author box + Person schema. | — |
| Related posts **[reuse]** | Suggested further reading to keep readers engaged. | Reuse related-posts logic. | — |
| Reader → client CTAs **[new]** | Inline CTAs converting readers into leads. | Reuse CTA + lead capture; placed within article. | — |
| Categories / tags **[reuse]** | Organize content for navigation and SEO. | Reuse `categories` + tags. | — |
| Bilingual articles **[reuse]** | Optional Arabic versions with RTL. | Reuse `_ar` content fields + language layer. | — |

### Portfolio (`/portfolio`) **[new]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Portfolio grid | Showcase of projects/case studies, filterable by service. | New `portfolio` collection; relation to `services`. | — |
| Project detail | Individual case study with media, description, and results. | Reuse rich-text + media handling; video support. | — |
| Media-rich layouts | Mix of video, image galleries, and text. | Reuse media optimization + gallery/video blocks. | — |
| Portfolio schema | Structured data for creative works. | `JsonLd` (CreativeWork) — SEO role manages. | SEO role manages meta |

### About Us (`/about`) **[reuse-adapted]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Agency story | Mission, vision, and the agency's story. | Reuse About sections (story, mission/vision). | — |
| Team / people (optional) | Showcase team members. | Adapt profile/achievements model to a team collection. | — |
| Certifications / recognition | Awards and accreditations. | Reuse certifications section. | — |
| Section visibility | Sections individually toggleable. | Reuse section-visibility engine. | — |

### Contact (`/contact`) **[reuse]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Contact form | Name/email/subject/message → creates a lead. | Reuse `submit-contact-form`. | — |
| Project inquiry fields **[new]** | Optional fields like service of interest, budget, timeline. | Extend lead schema with service/budget/timeline. | — |
| Contact info block | Email, location, phone with click-to-contact. | Reuse contact-info section. | — |
| FAQ | Common questions accordion. | Reuse FAQ blocks. | — |
| Spam protection | reCAPTCHA on submission. | Reuse reCAPTCHA integration. | — |

### Search (`/search`) **[reuse]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Full-text search | Search across blog, portfolio, and services. | Reuse `search-content`; extend to portfolio/services. | — |
| Type tabs, sort, date filters | Filter and sort results. | Reuse search UI. | — |
| Autocomplete | As-you-type suggestions. | Reuse `useSearchAutocomplete`. | — |
| Did-you-mean + suggestions | Spelling fixes and suggested queries. | Reuse zero-result suggestions. | — |

### Cross-public utilities **[reuse]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Dynamic custom pages | Spin up new public pages (e.g. campaigns, landing pages) from blocks. | Reuse `DynamicPage` + `pages`/`page_sections`. | — |
| Maintenance mode | Take the site offline with a maintenance page; allowlist IPs. | Reuse `useMaintenanceMode`. | Admin / Developer |
| Hidden pages | Hide specific pages from visitors site-wide. | Reuse `useHiddenPages`/page visibility. | Admin / Developer |
| 404 page | Friendly not-found page. | Reuse `NotFound`. | — |
| Page-view + CTA tracking | Records views and button clicks for analytics. | Reuse `usePageTracking` + CTA tracking. | — |

---

## Part 2: Admin Dashboard (CMS)

Authenticated CMS under `/admin`. Sidebar and actions gated by the four Braiin Station roles. The entire public site is dynamic and editable here.

### Authentication & accounts **[reuse]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Login | Email/password sign-in with validation. | Reuse `signInWithPassword` + `handle-login`. | — |
| Account lockout | Repeated failures lock an account. | Reuse failed-attempt tracking. | — |
| Forgot / reset password | Email reset link; set a new password. | Reuse reset flow. | — |
| Invite & accept | Invite teammates; they set name + password to activate. | Reuse invite flow. | Admin invites |
| Session + profile bootstrap | Loads user, role, avatar on sign-in. | Reuse `AuthProvider`. | — |

### Overview / Dashboard **[reuse-adapted]**

The landing dashboard with traffic and service-demand insights.

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Content stat cards | Totals/status for services, blog, portfolio. | Reuse `countByStatus`, adapted to new collections. | — |
| Quick actions | One-click "new article / service / portfolio item". | Reuse quick actions. | Hidden for read-only roles |
| Notification banners | Alerts: missing images, scheduled-today, unread leads, stale content. | Reuse banner logic. | Leads banner needs leads access |
| Service-demand insights **[new]** | Highlights which services clients ask about most (top inquiries/interest). | New: aggregate leads by `service_of_interest` + CTA clicks per service. | — |
| Upcoming schedule | Content queued to publish. | Reuse `useScheduledContent`. | — |
| Recent activity feed | Chronological log of admin actions. | Reuse `audit_log` feed. | — |

### Services management **[new]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Service CRUD | Create/edit/delete the 14 services. | New `services` collection; reuse content lifecycle. | Content Creator / Admin |
| Hero video per service | Attach a showreel video to each service. | Reuse multi-source video + metadata extraction. | Content Creator |
| Service details editor | Rich-text body, deliverables, process. | Reuse Tiptap editor; bilingual fields. | Content Creator |
| Order & visibility | Reorder and show/hide services. | Reuse reorder + visibility patterns. | Content Creator / Admin |
| Draft / teaser / publish | Including "coming soon" for Gaming. | Reuse status lifecycle. | Publish gated |
| Per-service SEO | Meta, slug, schema per service. | Reuse SEO fields. | SEO role |

### Creative Knowledge (Blog) management **[reuse]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Article list | Searchable, status/category-filtered. | Reuse blog list. | — |
| Create / edit / autosave | Full editor with silent autosave. | Reuse `saveDraft`/`autosave`. | Content Creator |
| Publish / schedule | Go live now or at a future time. | Reuse publish/schedule. | Publish gated |
| Duplicate / archive / delete | Clone or retire articles. | Reuse duplicate/archive/soft-delete. | Archive/delete = Admin |
| Bilingual fields | EN/AR title, body, meta, FAQ, takeaways. | Reuse `_ar` fields. | — |
| SEO + FAQ + takeaways blocks | AEO/GEO-friendly structured content. | Reuse SEO/FAQ/takeaways. | SEO role on meta |
| Auto word count / read time | Computed on save. | Reuse `countWords`. | — |
| Categories management | Manage content categories. | Reuse `categories`. | Content Creator |

### Portfolio management **[new]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Portfolio CRUD | Create/edit/delete case studies. | New `portfolio` collection; reuse lifecycle. | Content Creator |
| Service linking | Tag each project to one or more services. | Relation `portfolio`↔`services`. | Content Creator |
| Media-rich content | Video + image galleries + text. | Reuse media + gallery/video blocks. | Content Creator |
| Order & visibility | Reorder/show/hide projects. | Reuse reorder + visibility. | Content Creator |

### AI Style-Finder management **[new]** — *high-level*

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Questions & styles editor | Manage the quiz questions and style catalog. | New CMS module (to be detailed). | Content Creator / Admin |
| Results / logic config | Configure how answers map to recommendations. | Deferred to dedicated spec. | Admin |
| Results analytics | See what styles/answers are most common. | Feeds service-demand insights. | SEO / Admin read |

### Media Library **[reuse]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Upload (drag & drop) | Upload images/audio/video/PDF; auto dimensions. | Reuse `uploadFile` + dimension capture. | Content Creator / Developer |
| Browse / search / filter / sort | Grid or list, filter by type, search. | Reuse media library. | — |
| Folders | Organize assets into folders. | Reuse folder CRUD. | — |
| Edit metadata | Alt text, caption, tags; missing-alt warnings. | Reuse metadata editor (good for SEO). | SEO benefits |
| Copy URL / download | Public URL or download. | Reuse. | — |
| Archive vs. delete | Editors archive; admins hard-delete. | Reuse archive/delete split. | Hard delete = Admin |

### Pages & Navigation **[reuse]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Page list & create | Manage pages; create from templates. | Reuse pages CMS. | Content Creator / Admin |
| Page settings | Title, slug, status, nav visibility, SEO meta. | Reuse settings panel. | SEO on meta |
| Section editor | Add/edit/delete/reorder sections; content + style tabs. | Reuse section editor. | Content Creator |
| Per-section visibility & style | Show/hide and restyle sections individually. | Reuse visibility + style overrides. | — |
| Version history + restore | Last 10 saves per page; one-click restore. | Reuse `page_versions`. | — |
| Page visibility toggle | Hide/show whole pages from visitors. | Reuse `usePageVisibility`. | Admin / Developer |
| Navigation editor | Header/footer nav: labels (EN/AR), URLs, order, visibility. | Reuse nav editor. | Content Creator / Admin |
| Homepage strips editor | Manage client-logos strip + any stat counters. | Reuse partner-logos + statistics editors. | Content Creator |

### Leads **[reuse-adapted]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Leads + inquiries tabs | View contact leads and project inquiries. | Reuse leads module. | — |
| Service-of-interest field **[new]** | Capture which service a lead wants. | Extend lead schema; powers service-demand insights. | — |
| Search & status filter | Filter by text/status. | Reuse filters. | — |
| Detail panel + status + notes | Manage each lead through new/in-progress/done/spam with private notes. | Reuse detail panel; audit-logged. | Manage gated |
| Budget/timeline visibility | Sensitive fields limited to higher roles. | Reuse role-gated columns. | Admin / Developer |
| Export CSV | Download leads. | Reuse `export-csv`. | — |

### Analytics **[reuse-adapted]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Date-range controls | 7/30/90-day or custom. | Reuse `useAnalyticsData`. | — |
| Traffic stat cards + trends | Visits, sessions, page views with period change. | Reuse stat cards. | — |
| Traffic sources / devices / UTM | Source, device, and campaign breakdowns. | Reuse donut + tables. | — |
| Service interest analytics **[new]** | What services clients ask about / click most. | New aggregation over leads + per-service CTA clicks. | — |
| Content performance | Top articles/portfolio/services by views. | Reuse content performance. | — |
| CTA tracking | Click counts + conversion rates per CTA. | Reuse CTA tracking. | — |
| UTM builder | Generate campaign-tagged URLs. | Reuse builder. | SEO / Admin |
| Export CSV | Export active tables. | Reuse export. | Needs export permission |
| Search analytics | Top queries, zero-result queries, trends. | Reuse search analytics (valuable for SEO/AEO). | SEO / Admin / Developer |

### SEO / GEO / AEO Settings **[reuse-expanded]**

A first-class area, since the whole site must be SEO/GEO/AEO friendly.

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Global SEO defaults | Meta title template, default description, sitemap, robots.txt. | Reuse SEO defaults in settings. | SEO role |
| Per-page / per-entity meta | Meta title/description, OG image, slug on every page, service, article, portfolio item. | Reuse meta fields across collections. | SEO role |
| Structured data (schema) | JSON-LD for Organization, Service, Article, FAQ, Breadcrumb, CreativeWork, Speakable. | Reuse + extend `JsonLd` builders. | SEO role |
| AEO blocks | FAQ + key-takeaways + speakable markup to win AI answer boxes. | Reuse FAQ/takeaways/speakable. | SEO / Content Creator |
| Analytics integrations | GA4 + Search Console configuration. | Reuse integrations. | SEO / Admin |
| Redirects / canonical (recommended) **[new]** | Manage redirects and canonical URLs. | New small module recommended for SEO hygiene. | SEO role |

### UI Settings / Theme Editor **[reuse]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Theme presets + custom themes | Apply and save brand themes. | Reuse theme presets + `custom_themes`. | Admin / Developer |
| Live preview | See changes instantly in an embedded page preview. | Reuse `postMessage` preview bridge. | — |
| Colors / typography / layout / buttons | Full control of brand look and feel. | Reuse editors. | — |
| Save & publish / draft / discard | Publish live, save draft, or revert. | Reuse save flow. | — |
| Import / export JSON | Move themes in/out. | Reuse import/export. | — |

### Users & Permissions **[reuse-adapted]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| User list & role assignment | Invite users and assign Admin / Content Creator / SEO / Developer. | Reuse users module with new role set. | Admin only |
| Role-based access | Each role sees and does only what it should. | Reuse RBAC (`can`, `SIDEBAR_ACCESS`, `hasPermission`) with redefined permissions. | Admin defines |
| Audit log | Full history of who did what. | Reuse `audit_log`. | — |

### System Logs **[reuse]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Log table + detail | Browse application/error/system logs. | Reuse `system_logs`. | Developer / Admin |
| Stats + filters + live tail | 24h totals, errors, warnings; filter and real-time tail. | Reuse logs UI. | — |
| Export / clear | Download or clear old logs. | Reuse export/clear. | Clear = Admin |

### Site Health & Performance Panel **[reuse-expanded]** — Developer

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Health overview | At-a-glance site/system status. | Reuse `SiteHealthCard`, expanded. | Developer (+ Admin) |
| Web-vitals / performance | Real-user performance (LCP, CLS, INP, etc.) and poor-metric alerts. | Reuse `webVitals` reporting → performance logs. | Developer |
| Error monitoring | Unhandled errors and promise rejections in production. | Reuse `errorTracking` + Sentry hooks. | Developer |
| Backup export | Export all content as JSON. | Reuse `export-backup`. | Admin / Developer |

### General Settings **[reuse]**

| Feature | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Site identity | Site title, tagline, favicon, logos (incl. the Braiin Station logo). | Reuse identity settings. | Admin / Developer |
| Footer settings | Footer tagline, copyright, social/contact toggles. | Reuse footer settings. | — |
| Maintenance mode | Site-wide maintenance page + IP allowlist. | Reuse maintenance controls. | Admin / Developer |
| Localization | Default language (EN/AR), date format, timezone. | Reuse localization. | — |
| Integrations | GA4, Search Console, Calendly, reCAPTCHA. | Reuse integrations. | SEO / Admin |

---

## Part 3: Cross-Cutting Systems **[reuse unless noted]**

| System | Plain-Language Description | Technical Note | Role / Access |
|---|---|---|---|
| Role-based access control | Four roles (Admin, Content Creator, SEO, Developer) define what each user can see/do. | Reuse RBAC with Braiin Station permission map. | Defines all restrictions |
| Bilingual content (EN/AR) | Optional Arabic with RTL across content. | Reuse language layer + `_ar` fields. | — |
| Content lifecycle | Draft → scheduled → published → archived for services, blog, portfolio. | Reuse status + validation. | Publish/archive gated |
| Scheduling & auto-publish | Queue content to publish at a future time. | Reuse scheduling + `publish-scheduled`. | — |
| Audit logging | Records significant admin actions. | Reuse `audit_log`. | — |
| Page/section CMS engine | Pages composed of typed, reusable, styleable, toggleable, versioned sections. | Reuse `page_sections` + `page_versions`. | — |
| Analytics & tracking | Page views, CTA clicks, search + service-interest behavior. | Reuse tracking + new service-interest aggregation. | — |
| SEO / GEO / AEO engine | Meta + JSON-LD + FAQ/takeaways/speakable across all entity types. | Reuse + extend schema builders; first-class SEO settings. | SEO role |
| Media optimization | On-the-fly resize/compress + responsive images. | Reuse `optimizeImageUrl`/`buildSrcSet`. | — |
| Theming engine | Central brand theme (colors/type/layout/buttons), live-previewable. | Reuse theme engine. | Admin / Developer |
| Error & performance monitoring | Errors + web-vitals reported in production; surfaced in Developer health panel. | Reuse `errorTracking`/`sentry`/`webVitals`. | Developer |
| Maintenance & visibility gating | Take whole site or individual pages offline/hidden. | Reuse maintenance + visibility. | Admin / Developer |
| Rich-text editing | Tiptap editor with tables + LTR/RTL. | Reuse Tiptap extensions. | Content Creator |
| Notifications (toasts) | In-app success/error feedback. | Reuse toast system. | — |
| AI Style-Finder **[new]** | AI-driven style-discovery web app (questions + style catalog + recommendation). | New module; high-level only — dedicated spec to follow. | Content Creator / Admin |

---

## Notes & Open Items

- **AI Style-Finder** is deliberately high-level. A follow-up spec should cover: the question/scoring model, the style catalog data structure, the AI approach (provider, prompt/inference or embeddings-based matching), result storage, lead conversion, and cost/latency considerations.
- **Service-demand insights** (which services clients ask about) is a new analytics capability — it depends on adding a `service_of_interest` field to leads/inquiries and tracking per-service CTA clicks.
- **Gaming** service is scoped as a "coming later" teaser state rather than a fully built page.
- **Redirects/canonical management** is recommended as a small new SEO module for ranking hygiene; flag if you want it in v1 or later.
- Recommended new/extended collections vs. the prior platform: `services`, `portfolio`, AI style-finder data (`styles`, `questions`), and extended `leads` (service/budget/timeline).
