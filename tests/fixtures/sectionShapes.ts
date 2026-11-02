import type { z } from 'zod';
import { SECTION_CONTENT_SCHEMAS, SECTION_TYPES, type SectionType } from '@schemas/sections';
import { objectToPayload } from '@/lib/admin/formPayload';
import { SECTION_ADVANCED_ONLY, SECTION_UI } from '@/lib/admin/sectionUi';
import type { FieldDef } from '@/lib/admin/uiSchema';

// The shape of every section type's content, read from its zod schema (H15): every object the
// content may hold, by path (`heading`, `columns[]`, `media[].clip`), with the keys it names
// and whether its schema is strict. The strict-write spec (tests/lib/sectionWrite.spec.ts)
// holds its samples to it, and the production check that counts stored rows a strict write
// would refuse (h15_prod_check.sql, the build's scratchpad) is generated from it.

export interface ObjectShape {
  keys: string[];
  strict: boolean;
}

/** Every object path of a schema; a value the schema does not read into (a Tiptap body) is a leaf. */
export function objectShapes(schema: z.ZodTypeAny): Map<string, ObjectShape> {
  const out = new Map<string, ObjectShape>();
  const stack: { schema: z.ZodTypeAny; path: string }[] = [{ schema, path: '' }];
  while (stack.length > 0) {
    const { schema: next, path } = stack.pop()!;
    const def = next._def as {
      typeName: string;
      innerType?: z.ZodTypeAny;
      schema?: z.ZodTypeAny;
      type?: z.ZodTypeAny;
      unknownKeys?: string;
    };
    switch (def.typeName) {
      case 'ZodObject': {
        const shape = (next as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
        out.set(path, { keys: Object.keys(shape), strict: def.unknownKeys === 'strict' });
        for (const [key, value] of Object.entries(shape)) {
          stack.push({ schema: value, path: path ? `${path}.${key}` : key });
        }
        break;
      }
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodDefault':
        stack.push({ schema: def.innerType!, path });
        break;
      case 'ZodEffects':
        stack.push({ schema: def.schema!, path });
        break;
      case 'ZodArray':
        stack.push({ schema: def.type!, path: `${path}[]` });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Every section type with its content's object shapes (a type with no schema takes `{}`). */
export function sectionShapes(): Map<SectionType, Map<string, ObjectShape>> {
  return new Map(
    SECTION_TYPES.map((type) => {
      const schema = SECTION_CONTENT_SCHEMAS[type];
      return [
        type,
        schema ? objectShapes(schema) : new Map([['', { keys: [], strict: true }]]),
      ] as const;
    }),
  );
}

/** A plausible filled-in form value for one field (the typed editor's). */
export function sampleValue(field: FieldDef): unknown {
  switch (field.kind) {
    case 'bilingual':
    case 'prose':
      // The explorer's button label must name its discipline through the token (its help
      // says so; the schema refuses a label without it).
      return field.name === 'startLabel'
        ? { en: 'Start {discipline}', ar: 'ابدأ {discipline}' }
        : { en: 'Two words', ar: 'كلمتان هنا' };
    case 'number':
      return 1;
    case 'range':
      return field.range?.min ?? 1;
    // F5b: the form state of the three new kinds (src/lib/admin/formPayload.ts).
    case 'accent':
      return field.accent?.mode === 'from'
        ? { en: { from: 0, to: null }, ar: { from: 0, to: null } }
        : { en: { from: 0, to: 1 }, ar: { from: 0, to: 1 } };
    case 'link':
      return { label: { en: 'See all our work', ar: 'شاهد كل أعمالنا' }, href: '/portfolio' };
    case 'slugRelation':
      return ['hilton-rebrand', 'noon-campaign'].slice(0, field.maxItems ?? 2);
    case 'url':
      return 'https://instagram.com/braiinstatiion';
    case 'repeater':
      return [Object.fromEntries((field.itemFields ?? []).map((f) => [f.name, sampleValue(f)]))];
    case 'object':
      return Object.fromEntries((field.itemFields ?? []).map((f) => [f.name, sampleValue(f)]));
    case 'select':
      return field.options?.[0]?.value ?? 'value';
    case 'checkbox':
      return true;
    case 'media':
      return '5eed0a00-0000-4000-8000-000000000007';
    // E10: a body in both languages, and a gallery's pictures as the grid holds them.
    case 'richtext':
      return {
        en: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
        },
        ar: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'مرحبا' }] }],
        },
      };
    case 'gallery':
      return [{ kind: 'image', mediaId: '5eed0a00-0000-4000-8000-000000000007' }];
    case 'clip':
      return {
        source: 'path',
        streamUid: '',
        path: '/media/showreel.mp4',
        startS: '14',
        endS: '15.4',
      };
    default:
      // text fields: a value every text key accepts (a slug, a site-relative href)
      return field.name.endsWith('Href') ? '/portfolio' : 'value';
  }
}

/**
 * What the typed editor saves with every field filled in, plus the keys left to Advanced
 * (JSON) and the nested ones no field writes (a media item's per-use alt), so every object the
 * type's schema names is in it (tests/lib/sectionWrite.spec.ts holds that).
 */
export function fullSectionContent(type: SectionType): Record<string, unknown> {
  const fields = SECTION_UI[type] ?? [];
  const values = Object.fromEntries(fields.map((f) => [f.name, sampleValue(f)]));
  const content: Record<string, unknown> = objectToPayload(values, fields);
  for (const key of SECTION_ADVANCED_ONLY[type] ?? []) content[key] = true;
  if (type === 'workIntro' && Array.isArray(content['media'])) {
    content['media'] = (content['media'] as Record<string, unknown>[]).map((item) => ({
      ...item,
      altOverride: { en: 'A rider at dawn', ar: 'راكب عند الفجر' },
    }));
  }
  return content;
}
