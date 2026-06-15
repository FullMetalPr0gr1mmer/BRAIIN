-- Seed for local dev / fresh provisioning: the single launch tenant, its settings,
-- and the 14 services (Gaming as a published teaser). Run automatically by
-- `supabase db reset` / `supabase start`. Idempotent. Content team refines copy later.

insert into public.tenants (id, name, primary_domain)
values ('00000000-0000-0000-0000-0000000000b1', 'Braiin Station', 'www.braiinstation.com')
on conflict (id) do nothing;

insert into public.site_settings (tenant_id, identity)
values (
  '00000000-0000-0000-0000-0000000000b1',
  jsonb_build_object('title', 'Braiin Station', 'default_locale', 'en')
)
on conflict (tenant_id) do nothing;

insert into public.services (tenant_id, slug, title, blurb, status, is_teaser, sort_order) values
  ('00000000-0000-0000-0000-0000000000b1', 'branding',        '{"en":"Branding","ar":"الهوية البصرية"}',            '{"en":"Identity systems that make brands unmistakable.","ar":"أنظمة هوية تجعل العلامات لا تُنسى."}',        'published', false, 1),
  ('00000000-0000-0000-0000-0000000000b1', 'animations',      '{"en":"Animations","ar":"الرسوم المتحركة"}',          '{"en":"Characters and stories brought to life.","ar":"شخصيات وقصص تنبض بالحياة."}',                         'published', false, 2),
  ('00000000-0000-0000-0000-0000000000b1', 'motion-graphics', '{"en":"Motion Graphics","ar":"موشن جرافيك"}',         '{"en":"Design in motion for screens of every size.","ar":"تصميم متحرك لكل الشاشات."}',                      'published', false, 3),
  ('00000000-0000-0000-0000-0000000000b1', 'videography',     '{"en":"Videography","ar":"إنتاج الفيديو"}',           '{"en":"Cinematic production end to end.","ar":"إنتاج سينمائي من الفكرة إلى التسليم."}',                      'published', false, 4),
  ('00000000-0000-0000-0000-0000000000b1', 'photography',     '{"en":"Photography","ar":"التصوير الفوتوغرافي"}',     '{"en":"Images that sell the moment.","ar":"صور تروي اللحظة."}',                                             'published', false, 5),
  ('00000000-0000-0000-0000-0000000000b1', 'montage',         '{"en":"Montage","ar":"المونتاج"}',                   '{"en":"Editing that gives footage its rhythm.","ar":"مونتاج يمنح اللقطات إيقاعها."}',                        'published', false, 6),
  ('00000000-0000-0000-0000-0000000000b1', 'event-planning',  '{"en":"Event Planning","ar":"تنظيم الفعاليات"}',      '{"en":"Experiences planned down to the detail.","ar":"تجارب مُخطَّطة حتى أدق التفاصيل."}',                   'published', false, 7),
  ('00000000-0000-0000-0000-0000000000b1', 'advertising',     '{"en":"Advertising","ar":"الإعلانات"}',              '{"en":"Campaigns that move audiences.","ar":"حملات تحرّك الجمهور."}',                                       'published', false, 8),
  ('00000000-0000-0000-0000-0000000000b1', 'social-media',    '{"en":"Social Media","ar":"وسائل التواصل"}',          '{"en":"Always-on presence that converts.","ar":"حضور دائم يحقق النتائج."}',                                  'published', false, 9),
  ('00000000-0000-0000-0000-0000000000b1', 'web-development', '{"en":"Web Development","ar":"تطوير المواقع"}',       '{"en":"Fast, secure, accessible sites.","ar":"مواقع سريعة وآمنة وسهلة الوصول."}',                            'published', false, 10),
  ('00000000-0000-0000-0000-0000000000b1', 'seo-geo-aeo',     '{"en":"SEO / GEO / AEO","ar":"تحسين محركات البحث"}',  '{"en":"Be found by people and AI answer engines.","ar":"ظهور أمام الناس ومحركات الإجابة بالذكاء الاصطناعي."}', 'published', false, 11),
  ('00000000-0000-0000-0000-0000000000b1', 'music',           '{"en":"Music","ar":"الموسيقى"}',                     '{"en":"Original sound and scoring.","ar":"موسيقى وتلحين أصلي."}',                                            'published', false, 12),
  ('00000000-0000-0000-0000-0000000000b1', 'merchandise',     '{"en":"Merchandise","ar":"المنتجات الترويجية"}',      '{"en":"Branded products people keep.","ar":"منتجات تحمل العلامة ويحتفظ بها الناس."}',                        'published', false, 13),
  ('00000000-0000-0000-0000-0000000000b1', 'gaming',          '{"en":"Gaming","ar":"الألعاب"}',                     '{"en":"Coming soon.","ar":"قريبًا."}',                                                                      'published', true,  14)
on conflict (tenant_id, slug) do nothing;

-- A few published case studies so the portfolio renders before the content team
-- authors real work. Content refines copy and attaches services later.
insert into public.portfolio (tenant_id, slug, title, summary, status, sort_order) values
  ('00000000-0000-0000-0000-0000000000b1', 'riyadh-season-launch', '{"en":"Riyadh Season Launch","ar":"إطلاق موسم الرياض"}', '{"en":"A full-funnel campaign — brand film, motion graphics, and always-on social.","ar":"حملة متكاملة — فيلم للعلامة، وموشن جرافيك، وحضور دائم على وسائل التواصل."}', 'published', 1),
  ('00000000-0000-0000-0000-0000000000b1', 'cafe-rebrand',         '{"en":"Specialty Café Rebrand","ar":"إعادة هوية مقهى مختص"}', '{"en":"A new identity system, packaging, and storefront photography.","ar":"نظام هوية جديد، وتغليف، وتصوير للواجهة."}', 'published', 2),
  ('00000000-0000-0000-0000-0000000000b1', 'fintech-product-film', '{"en":"Fintech Product Film","ar":"فيلم منتج لشركة تقنية مالية"}', '{"en":"Scriptwriting, cinematic production, and a 60-second cutdown for paid media.","ar":"كتابة سيناريو، وإنتاج سينمائي، ونسخة 60 ثانية للإعلانات المدفوعة."}', 'published', 3)
on conflict (tenant_id, slug) do nothing;
