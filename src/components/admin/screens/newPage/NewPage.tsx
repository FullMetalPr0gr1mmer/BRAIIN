import { useId, useState, type FormEvent } from 'react';
import { CUSTOM_PAGE_SLUG_MAX, suggestPageSlug } from '@schemas/customPages';
import Modal from '@/components/admin/kit/Modal';
import Icon from '@/components/admin/kit/Icon';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { stagedUrl } from '@/lib/admin/releaseEvents';
import {
  heroPayload,
  newPageErrors,
  newPagePayload,
  type NewPageErrors,
  type NewPageInput,
} from './model';

// "New page" (Admin v2 E11, ui.md AV-33: "New page dialog: EN and AR title plus slug"), on the
// pages list for a role with pages.write (Admin, Content Creator; the server page renders this
// island for them only, and the route refuses anyone else). The title in both languages and
// the address, suggested from the English title until the address is typed in. The page is
// created as a draft through the resource kernel (POST /api/admin/pages, marked in release
// mode, R12b), then its banner hero with the title as its headline, and the editor opens on
// it. Every rule is the server's too (model.ts); a refusal is said on its field.

type Row = Record<string, unknown>;

export interface NewPageProps {
  /** The pages list's own answer: releases on, so every write here is staged. */
  releaseMode: boolean;
  /** Open at once (`/admin/pages?new=1`, where /admin/pages/new sends). */
  startOpen?: boolean | undefined;
}

const EMPTY: NewPageInput = { titleEn: '', titleAr: '', slug: '' };

/** The server's refusal of the address, in its words: the trigger's or the schema's. */
function slugRefusal(err: AdminApiError): string | null {
  if (err.info.field === 'slug') return err.info.detail ?? describeError(err);
  return err.info.issues?.find((issue) => issue.path === 'slug')?.message ?? null;
}

export default function NewPage({ releaseMode, startOpen = false }: NewPageProps) {
  const [open, setOpen] = useState(startOpen);
  const [input, setInput] = useState<NewPageInput>(EMPTY);
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<NewPageErrors>({});
  const [failure, setFailure] = useState('');
  const [working, setWorking] = useState(false);
  const id = useId();

  const close = () => {
    if (working) return;
    setOpen(false);
    setInput(EMPTY);
    setSlugTouched(false);
    setErrors({});
    setFailure('');
  };

  const set = (key: keyof NewPageInput, value: string) => {
    setInput((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'titleEn' && !slugTouched) next.slug = suggestPageSlug(value);
      return next;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = newPageErrors(input);
    setErrors(found);
    setFailure('');
    if (Object.keys(found).length > 0) return;
    setWorking(true);
    try {
      const page = await adminFetch<Row>(stagedUrl('/api/admin/pages', releaseMode), {
        method: 'POST',
        body: newPagePayload(input),
      });
      const pageId = typeof page['id'] === 'string' ? page['id'] : '';
      if (!pageId) throw new Error('The page was made, but its address could not be read.');
      try {
        await adminFetch<Row>(stagedUrl('/api/admin/sections', releaseMode), {
          method: 'POST',
          body: heroPayload(pageId, input),
        });
      } catch {
        // The page is made. Without its hero it still opens with its title (the route's floor),
        // and the editor's Add section puts one in: open the editor rather than fail here.
      }
      window.location.assign(`/admin/pages/${pageId}`);
    } catch (err) {
      setWorking(false);
      const slugIssue = err instanceof AdminApiError ? slugRefusal(err) : null;
      if (slugIssue) {
        setErrors({ slug: slugIssue });
        return;
      }
      if (err instanceof AdminApiError && (err.info.field === 'title' || err.info.issues)) {
        setFailure('Check the title in both languages, then try again.');
        return;
      }
      setFailure(describeError(err));
    }
  };

  const field = (
    key: keyof NewPageInput,
    label: string,
    hint: string,
    extra: { dir?: 'rtl' | 'ltr' | 'auto'; lang?: string; maxLength?: number; prefix?: string },
  ) => {
    const inputId = `${id}-${key}`;
    const error = errors[key];
    return (
      <div className="f" data-invalid={error ? '' : undefined}>
        <div className="f__l">
          <label htmlFor={inputId}>{label}</label>
        </div>
        <input
          id={inputId}
          type="text"
          value={input[key]}
          autoComplete="off"
          spellCheck={key !== 'slug'}
          dir={extra.dir}
          lang={extra.lang}
          maxLength={extra.maxLength}
          aria-describedby={`${inputId}-hint${error ? ` ${inputId}-err` : ''}`}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            if (key === 'slug') setSlugTouched(true);
            set(key, key === 'slug' ? e.target.value.toLowerCase() : e.target.value);
          }}
        />
        {error && (
          <p className="field-error f__err" id={`${inputId}-err`} role="alert">
            {error}
          </p>
        )}
        <p className="f__hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      </div>
    );
  };

  return (
    <>
      <button type="button" className="btn" data-variant="primary" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} />
        New page
      </button>
      <Modal
        open={open}
        onClose={close}
        title="New page"
        sub="A page of your own, in English and Arabic. It starts as a draft with a banner of its title; add its sections in the editor."
        dismissible={false}
        footer={
          <>
            <button type="button" className="btn" data-variant="ghost" onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn"
              data-variant="primary"
              form={`${id}-form`}
              disabled={working}
            >
              {working ? 'Making the page…' : 'Make the page'}
            </button>
          </>
        }
      >
        <form id={`${id}-form`} noValidate onSubmit={(e) => void submit(e)}>
          {field(
            'titleEn',
            'Title in English',
            'Its headline, and its name in the menus and in search results. Up to ten words.',
            {
              dir: 'ltr',
              lang: 'en',
            },
          )}
          {field('titleAr', 'Title in Arabic', 'The same, for the Arabic page.', {
            dir: 'rtl',
            lang: 'ar',
          })}
          {field(
            'slug',
            'Address',
            input.slug
              ? `The page will be at /${input.slug} and /ar/${input.slug}. The editor does not change it later.`
              : 'Lowercase letters, digits and hyphens, like our-story.',
            { dir: 'ltr', maxLength: CUSTOM_PAGE_SLUG_MAX },
          )}
          {failure && (
            <p className="msg" data-kind="error" role="alert">
              {failure}
            </p>
          )}
        </form>
      </Modal>
    </>
  );
}
