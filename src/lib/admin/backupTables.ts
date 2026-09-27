// What the content backup export (`/api/admin/export-backup`, `export.backup`) dumps — and
// what it must never dump. Kept apart from the route so tests/lib/exportBackup.spec.ts can
// hold the two lists against each other and against the schema.
//
// ── What this deliberately does NOT contain ──────────────────────────────────────
// No leads, in any form. Not even ciphertext. A "backup" that quietly includes the lead
// table would let `export.backup` stand in for `export.csv` and route around the PII
// gate entirely — and the two capabilities are listed separately in §5 precisely
// because they are different decisions. The same holds for job applications (Admin-only,
// UI v2 decision 4 — Developer holds export.backup and must not reach them this way),
// consent records and the public-write rate-limit ledger. Database-level backup with
// PII is the DR path (§10: pg_dump → object-locked R2), under different custody.

/** Content only. Every table here is publishable material or its configuration. */
export const BACKUP_TABLES: readonly { table: string; columns: string }[] = [
  // Disciplines before services: a restore inserts in this order, and services point at them.
  {
    table: 'disciplines',
    columns:
      'id,slug,name,short,blurb,poster_media_id,preview_video_path,preview_start_s,preview_end_s,' +
      'status,sort_order,published_at,scheduled_for,updated_at',
  },
  {
    table: 'services',
    columns:
      'id,slug,title,short_title,blurb,body,hero_video_uid,category,status,is_teaser,sort_order,' +
      'updated_at,discipline_id,intro,value_points,deliverables,poster_media_id,' +
      'preview_video_path,preview_start_s,preview_end_s',
  },
  {
    table: 'blog_posts',
    columns:
      'id,slug,title,excerpt,body,author_id,category_id,cover_image_url,status,published_at,updated_at',
  },
  {
    table: 'portfolio',
    columns:
      'id,slug,title,summary,body,status,sort_order,published_at,scheduled_for,project_type,' +
      'teaser,lead,goal,result,scope,keywords,results,sector_id,client_id,year,is_featured,' +
      'poster_media_id,preview_video_uid,preview_video_path,preview_start_s,preview_end_s,' +
      'next_portfolio_id,is_placeholder,updated_at',
  },
  { table: 'portfolio_services', columns: 'portfolio_id,service_id,sort_order' },
  {
    table: 'portfolio_media',
    columns:
      'id,portfolio_id,role,kind,media_id,video_uid,video_path,clip_start_s,clip_end_s,' +
      'duration_label,caption,breakdown_kind,layout,sort_order',
  },
  // After services and portfolio: a case points at both.
  {
    table: 'service_cases',
    columns:
      'id,service_id,portfolio_id,title,context,problems,results,status,published_at,' +
      'scheduled_for,is_placeholder,updated_at',
  },
  { table: 'sectors', columns: 'id,slug,name,visible,sort_order,updated_at' },
  {
    table: 'clients',
    columns:
      'id,slug,name,logo_media_id,website_url,show_in_marquee,visible,is_placeholder,sort_order,updated_at',
  },
  {
    // consent_obtained_at travels with the quote — a restore without it could not re-publish
    // it (the 0021 CHECK). consent_reference (where the consent record is kept) does not:
    // it points into correspondence a content backup has no reason to carry.
    table: 'testimonials',
    columns:
      'id,slug,quote,author_name,author_role,client_id,portfolio_id,avatar_media_id,placements,' +
      'consent_obtained_at,status,published_at,scheduled_for,sort_order,is_placeholder,updated_at',
  },
  { table: 'pages', columns: 'id,slug,title,status,nav_visible,updated_at' },
  {
    table: 'page_sections',
    columns: 'id,page_id,type,content,style,visible,sort_order,is_placeholder,updated_at',
  },
  {
    table: 'navigation',
    columns: 'id,location,parent_id,label,href,visible,is_key,sort_order',
  },
  {
    table: 'site_profile',
    columns:
      'brand_name,legal_name,contact_email,whatsapp_e164,whatsapp_display,location,' +
      'address_locality,address_country,founded_year,socials,accepting_applications,updated_at',
  },
  { table: 'categories', columns: 'id,slug,name' },
  {
    table: 'team_members',
    columns:
      'id,slug,name,bio,avatar_url,role,linkedin_url,is_leadership,portrait_media_id,status,' +
      'sort_order,is_placeholder',
  },
  { table: 'certifications', columns: 'id,slug,name,issuer,year,logo_url,status,sort_order' },
  {
    table: 'statistics',
    columns:
      'id,slug,label,value,value_numeric,value_suffix,placements,placement_labels,status,' +
      'sort_order,is_placeholder',
  },
  { table: 'partner_logos', columns: 'id,name,logo_url,scale,offset_y,visible,sort_order' },
  { table: 'redirects', columns: 'id,source_path,target_path,status' },
  {
    table: 'entity_seo',
    columns:
      'id,entity_type,entity_id,meta_title,meta_description,og_image,canonical_override,robots,schema_type',
  },
  {
    table: 'media_assets',
    columns: 'id,kind,provider,storage_path,folder,alt,tags,width,height,mime_type',
  },
  {
    table: 'ai_questions',
    columns: 'id,slug,prompt,help_text,input_type,options,status,sort_order',
  },
  { table: 'ai_styles', columns: 'id,slug,name,description,traits,image_url,status,sort_order' },
];

/**
 * Never in a content backup, whoever asks — personal data, consent records and security
 * ledgers. Several of these arrive with later UI v2 migrations (0026+); listing them now
 * means the day they exist, adding one to BACKUP_TABLES fails a test instead of a review.
 */
export const FORBIDDEN_BACKUP_TABLES: readonly string[] = [
  'leads',
  'leads_safe',
  'job_applications',
  'applications_safe',
  'cv_deletion_queue',
  'public_write_attempts',
  'notification_log',
  'consent_log',
  'audit_log',
  'profiles',
];
