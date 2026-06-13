import { z } from 'zod';
import { anonClient } from '@/lib/supabase/client';

// Runtime data access for the public services (Tier A SSR). Tenant + published
// filtering are enforced by RLS; we still pass status explicitly. Zod-validated.
// Resilient: returns []/null on any error (e.g. before Supabase is provisioned) so
// builds and the shell never break — pages render an empty state.

const LocalizedSchema = z.record(z.string(), z.string());

const ServiceRowSchema = z.object({
  slug: z.string(),
  title: LocalizedSchema,
  blurb: LocalizedSchema.nullable(),
  body_html: LocalizedSchema.nullable(),
  hero_video_uid: z.string().nullable(),
  category: z.string().nullable(),
  is_teaser: z.boolean(),
  sort_order: z.number(),
});
export type ServiceRow = z.infer<typeof ServiceRowSchema>;

const COLUMNS = 'slug,title,blurb,body_html,hero_video_uid,category,is_teaser,sort_order';

export async function getPublishedServices(): Promise<ServiceRow[]> {
  try {
    const { data, error } = await anonClient()
      .from('services')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return data.flatMap((row) => {
      const parsed = ServiceRowSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

export async function getServiceBySlug(slug: string): Promise<ServiceRow | null> {
  try {
    const { data, error } = await anonClient()
      .from('services')
      .select(COLUMNS)
      .eq('status', 'published')
      .eq('slug', slug)
      .maybeSingle();
    if (error || !data) return null;
    const parsed = ServiceRowSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
