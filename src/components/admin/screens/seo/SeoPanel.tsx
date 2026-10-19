import { useEffect, useMemo, useState } from 'react';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { CANONICAL_PATH_PATTERN, SEO_DESCRIPTION_MAX, SEO_TITLE_MAX } from '@schemas/seoRules';
import { Field } from '@/components/admin/FormField';
import EditorForm from '@/components/admin/fields/EditorForm';
import SwitchField from '@/components/admin/fields/SwitchField';
import Modal from '@/components/admin/kit/Modal';
import Note from '@/components/admin/kit/Note';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { useEntitySave, type EntitySave } from '@/lib/admin/useEntitySave';
import { canonicalPath } from '@/lib/seo/canonical';
import { isNoindex, pageRobots } from '@/lib/seo/robots';
import GooglePreview from './GooglePreview';
import type { Bi, SeoPanelSetup } from './types';

// The shared SEO editor of one page (Admin v2 U10, ui.md AV-19 "SeoDrawer", the prototype's
// seoDrawer). The SEO screen shows it in a drawer (SeoDrawer); the Services, Projects and
// Blog editors (U5, U6, U8) and the page editor's SEO drawer (E1) show it in their own SEO tab.
//
// THE API (kept small on purpose; later editors build on it):
//   <SeoPanel target={…} context={…} readOnly? canAdvanced? onSaved? />
//   - `target` and `context` are `loadSeoPanelSetup(sb, auth, type, id)`'s answer
//     (src/lib/admin/seo/list.ts), made on the editor's server page and passed to its island:
//     which page, its path, the site's brand and title template, the page's own default
//     words, and the site's robots default. The SEO screen builds the same shape from a row
//     of its Pages list.
//   - `readOnly`: the values as text and the previews, no Save (Content Creator holds
//     `seo.entityMeta` at view). The server refuses a save anyway.
//   - `canAdvanced`: shows Advanced (the canonical address); Admin and SEO (`seo.entityMeta`
//     at full). Without it a stored address is kept as it is.
//   - `onSaved`: after a save went through (the SEO list refreshes its row).
// It loads and saves through useEntitySave's `entitySeo` target (GET and PUT
// /api/admin/entity-seo): a full replace, so every column the row holds is carried in the
// form, shown or not (the legacy image link, robots, the canonical address, the schema type).
//
// An empty box keeps the page's default, which its placeholder and the previews show. A
// title or a description written in one language needs the other (the pair rule, refused by
// the server on the missing half). Index is a switch; turning it off asks first.

export interface SeoPanelProps {
  target: SeoPanelSetup['target'];
  context: SeoPanelSetup['context'];
  readOnly?: boolean | undefined;
  canAdvanced?: boolean | undefined;
  onSaved?: (() => void) | undefined;
}

/** The structured data each kind of page carries (code-owned, CI-validated; U10 D7). */
export const SCHEMA_OF_TYPE: Record<SeoPanelSetup['target']['entityType'], string> = {
  page: 'WebPage',
  service: 'Service',
  portfolio: 'CreativeWork',
  blog_post: 'BlogPosting',
};

export const INDEX_LABEL = 'Let search engines index this page';
export const FOLLOWING_DEFAULT = 'Following the site default.';
export const HIDE_TITLE = 'Hide this page from search engines?';
export const HIDE_TEXT =
  'Google and other search engines stop showing it, and it leaves the sitemap. People with the link can still open it.';
export const LEGACY_IMAGE_NOTE = 'An image link set before is still used for sharing.';

/** The fields the form carries: the three it shows, then the four a full replace keeps. */
export function seoPanelFields(defaults: SeoPanelSetup['context']['defaults']): FieldDef[] {
  return [
    {
      name: 'metaTitle',
      label: 'Page title (shows in Google and the browser tab)',
      kind: 'bilingual',
      column: 'meta_title',
      maxLength: SEO_TITLE_MAX,
      placeholder: defaults.title,
      help: '50 to 60 characters works best. Leave both empty to keep the page’s own title.',
    },
    {
      name: 'metaDescription',
      label: 'Description',
      kind: 'bilingual',
      multiline: true,
      column: 'meta_description',
      maxLength: SEO_DESCRIPTION_MAX,
      placeholder: defaults.description,
      help: '150 to 160 characters works best. Leave both empty to keep the page’s own words.',
    },
    {
      name: 'ogMediaId',
      label: 'Social share image',
      kind: 'media',
      column: 'og_media_id',
      help: 'Shown when the page is shared. Empty: the page’s own image, then the site’s default.',
    },
    // Carried, never shown as boxes: drawn below by the panel, or kept as they are.
    { name: 'ogImage', label: 'Image link set before', kind: 'url', column: 'og_image' },
    {
      name: 'robots',
      label: INDEX_LABEL,
      kind: 'select',
      column: 'robots',
      options: [
        { value: 'index,follow', label: 'Index' },
        { value: 'noindex,follow', label: 'Hide' },
      ],
    },
    {
      name: 'canonicalOverride',
      label: 'Address search engines should index instead',
      kind: 'text',
      column: 'canonical_override',
      help: 'A path on this site, such as /services/logo. The Arabic page follows on its own. Leave it empty for almost every page.',
    },
    { name: 'schemaType', label: 'Schema type', kind: 'text', column: 'schema_type' },
  ];
}

const SHOWN = new Set(['metaTitle', 'metaDescription', 'ogMediaId']);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const pair = (value: unknown): Bi => {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { en: text(record['en']), ar: text(record['ar']) };
};

/**
 * Values stored before U10's rules, made into ones a save may send (read leniently, written
 * strictly): a free-text robots value as its closed form, an absolute canonical on this
 * site as its path. Null when nothing needs to change.
 */
export function legacyFixes(values: Record<string, unknown>): Record<string, unknown> | null {
  const fixes: Record<string, unknown> = {};
  const robots = text(values['robots']);
  if (robots && robots !== 'index,follow' && robots !== 'noindex,follow') {
    fixes['robots'] = pageRobots(robots) ?? '';
  }
  const canonical = text(values['canonicalOverride']).trim();
  if (canonical && !CANONICAL_PATH_PATTERN.test(canonical)) {
    fixes['canonicalOverride'] = canonicalPath(canonical, PUBLIC_SITE_URL) ?? '';
  }
  return Object.keys(fixes).length > 0 ? fixes : null;
}

export default function SeoPanel({
  target,
  context,
  readOnly = false,
  canAdvanced = false,
  onSaved,
}: SeoPanelProps) {
  const fields = useMemo(() => seoPanelFields(context.defaults), [context.defaults]);
  const shown = useMemo(() => fields.filter((field) => SHOWN.has(field.name)), [fields]);
  const save = useEntitySave(
    { kind: 'entitySeo', entityType: target.entityType, entityId: target.entityId },
    null,
    { fields },
  );
  const [confirmHide, setConfirmHide] = useState(false);

  const loaded = !save.busy && save.loadError === null;
  useEffect(() => {
    if (!loaded || readOnly) return;
    const fixes = legacyFixes(save.values);
    if (fixes) for (const [name, value] of Object.entries(fixes)) save.set(name, value);
    // Once per load: the values are read when the row arrives.
  }, [loaded, readOnly]); // eslint-disable-line

  const values = save.values;
  const robots = text(values['robots']) || null;
  const effective = robots ?? context.defaultRobots;
  const indexed = !isNoindex(effective);
  const legacyImage = text(values['ogImage']).trim();

  // A save that went through tells the screen (the list refreshes its row).
  const tracked: EntitySave = useMemo(
    () => ({
      ...save,
      save: async () => {
        const ok = await save.save();
        if (ok) onSaved?.();
        return ok;
      },
    }),
    [save, onSaved],
  );

  const preview = (
    <GooglePreview
      title={pair(values['metaTitle'])}
      description={pair(values['metaDescription'])}
      defaults={context.defaults}
      brand={context.brand}
      template={context.titleTemplate}
      path={target.path}
    />
  );
  const schemaRow = (
    <p className="seo-panel__fact">
      Structured data: {SCHEMA_OF_TYPE[target.entityType]} (set by the page type)
    </p>
  );

  if (readOnly) {
    if (save.loadError) {
      return (
        <p className="msg" data-kind="error" role="alert">
          {save.loadError}
        </p>
      );
    }
    if (save.busy) return <p className="admin-sub">Loading…</p>;
    return (
      <div className="seo-panel" data-readonly="">
        <Note tone="info">Only Admin and SEO change these.</Note>
        <dl className="seo-panel__view">
          {(['metaTitle', 'metaDescription'] as const).map((name) => {
            const own = pair(values[name]);
            const fallback =
              name === 'metaTitle' ? context.defaults.title : context.defaults.description;
            return (
              <div key={name}>
                <dt>{name === 'metaTitle' ? 'Page title' : 'Description'}</dt>
                {(['en', 'ar'] as const).map((lang) => (
                  <dd key={lang} lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
                    {own[lang].trim() || fallback[lang] || ' '}
                    {!own[lang].trim() && (
                      <span className="seo-panel__default" lang="en" dir="ltr">
                        {' '}
                        (default)
                      </span>
                    )}
                  </dd>
                ))}
              </div>
            );
          })}
          <div>
            <dt>Social share image</dt>
            <dd>{text(values['ogMediaId']) || legacyImage ? 'Chosen' : 'The page’s own image'}</dd>
          </div>
          <div>
            <dt>Search engines</dt>
            <dd>
              {indexed ? 'Indexed' : 'Hidden'}
              {robots === null ? ` (${FOLLOWING_DEFAULT.replace(/\.$/, '').toLowerCase()})` : ''}
            </dd>
          </div>
        </dl>
        {schemaRow}
        {preview}
      </div>
    );
  }

  const after = (
    <div className="seo-panel">
      {legacyImage && (
        <Note tone="warn" className="seo-panel__legacy">
          <span>{LEGACY_IMAGE_NOTE} The picture above wins when both are set.</span>
          <button type="button" className="btn" onClick={() => save.set('ogImage', '')}>
            Remove the link
          </button>
        </Note>
      )}
      <div className="card seo-panel__index">
        <SwitchField
          field={{
            name: 'indexed',
            label: INDEX_LABEL,
            kind: 'checkbox',
            ...(robots === null ? { help: FOLLOWING_DEFAULT } : {}),
          }}
          value={indexed}
          idPrefix="seo"
          onChange={(_name, next) => {
            if (next === true) save.set('robots', 'index,follow');
            else setConfirmHide(true);
          }}
        />
      </div>
      {canAdvanced && (
        <details className="seo-panel__adv">
          <summary>Advanced</summary>
          <Field
            field={fields.find((field) => field.name === 'canonicalOverride')!}
            value={values['canonicalOverride']}
            onChange={save.set}
            errors={save.errors.byId}
          />
        </details>
      )}
      {schemaRow}
      {preview}
      <Modal
        open={confirmHide}
        onClose={() => setConfirmHide(false)}
        title={HIDE_TITLE}
        sub={HIDE_TEXT}
        footer={
          <>
            <button
              type="button"
              className="btn"
              data-variant="ghost"
              data-autofocus=""
              onClick={() => setConfirmHide(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              data-variant="danger"
              onClick={() => {
                save.set('robots', 'noindex,follow');
                setConfirmHide(false);
              }}
            >
              Hide from search
            </button>
          </>
        }
      >
        <p>{target.label}</p>
      </Modal>
    </div>
  );

  return <EditorForm save={tracked} fields={shown} submitLabel="Save SEO" after={after} />;
}
