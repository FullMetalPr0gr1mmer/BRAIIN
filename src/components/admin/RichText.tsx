import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useState, type ComponentType } from 'react';
import type { JSONContent } from '@tiptap/core';
import type { TiptapDoc } from '@schemas/tiptap';
// Types only: nothing from the shared admin code is imported at runtime here, or it would
// be pulled into this lazy chunk (the LinkDialog arrives as a prop instead).
import type { LinkDialogProps } from './fields/LinkDialog';

// The rich-text editor: Tiptap and ProseMirror, about 100 KB gzipped. FormField loads
// this module with import(), and astro.config.mjs's `admin-rich` group keeps it and its
// stack in their own lazy chunk, so only a form with a rich-text field downloads them
// (scripts/admin-bundle.mjs checks that on every build).
//
// ── The editor is not a security boundary ────────────────────────────────────────
// Nothing here sanitises anything, deliberately. What this component produces is Tiptap
// JSON, which the server re-validates and then renders through the allowlist renderer in
// `src/lib/content/tiptap.ts`. Treating the editor as the sanitiser is the classic
// mistake: it is client code, and the API accepts a JSON body from anyone with a
// session regardless of what the editor would have allowed them to type.
//
// What the editor DOES do is stay inside what the renderer can express — there is no
// point offering a colour picker whose output the renderer drops on the floor.

export interface RichTextProps {
  value: TiptapDoc | null;
  onChange: (doc: TiptapDoc) => void;
  label: string;
  /** Arabic gets an RTL editing surface so authors see the real reading order. */
  locale?: 'en' | 'ar';
  /** The editable surface's id, so an error link (fieldErrors.ts) can focus it. */
  id?: string | undefined;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
  /** The link dialog (FormField passes fields/LinkDialog). Without one, no link button. */
  linkDialog?: ComponentType<LinkDialogProps> | undefined;
}

const EMPTY: TiptapDoc = { type: 'doc', content: [] };

/**
 * Our TiptapDoc and Tiptap's JSONContent describe the same JSON but disagree in the
 * type system: under `exactOptionalPropertyTypes`, ours says `content?: Node[] |
 * undefined` and theirs says `content?: Node[]`. Widening at this single boundary is
 * cheaper and clearer than making the shared schema mirror a library's internal type —
 * the schema is the contract the SERVER validates against, and it should not move
 * because an editor package changed.
 */
function asEditorContent(doc: TiptapDoc): JSONContent {
  return doc as JSONContent;
}

/** The sprite's icon, drawn here (kit/Icon.tsx is shared code: see the import note). */
function Glyph({ name }: { name: string }) {
  return (
    <svg className="ic" width="15" height="15" aria-hidden="true" focusable="false">
      <use href={`/styles/admin-icons.svg#i-${name}`} />
    </svg>
  );
}

export default function RichText({
  value,
  onChange,
  label,
  locale = 'en',
  id,
  invalid,
  describedBy,
  linkDialog: LinkDialog,
}: RichTextProps) {
  const [linking, setLinking] = useState<{ href: string } | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // The renderer clamps headings to h2–h6 (the page's h1 is the entity title), so
        // offering h1 in the toolbar would silently demote it and confuse the author.
        heading: { levels: [2, 3, 4] },
        // A link in the editor is text being edited, not a way off the page.
        link: { openOnClick: false },
      }),
    ],
    content: asEditorContent(value ?? EMPTY),
    // Astro renders islands on the server first; Tiptap must not try to measure a DOM
    // that does not exist yet.
    immediatelyRender: false,
    // No runtime <style>. By default Tiptap appends its ProseMirror base CSS to <head> as
    // an inline <style>, which style-src (nonce-only, no 'unsafe-inline') refuses: every
    // editor screen logged a CSP violation and ran WITHOUT ProseMirror's required
    // `white-space: pre-wrap`. The same rules ship in public/styles/admin.css instead
    // (the Tiptap section), found by the Admin v2 F0 sweep.
    injectCSS: false,
    editorProps: {
      attributes: {
        class: 'tiptap',
        dir: locale === 'ar' ? 'rtl' : 'ltr',
        lang: locale,
        'aria-label': label,
        role: 'textbox',
        'aria-multiline': 'true',
        ...(id ? { id } : {}),
        ...(invalid ? { 'aria-invalid': 'true' } : {}),
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChange(instance.getJSON() as TiptapDoc);
    },
  });

  // Re-seed when the parent loads a different row. Guarded by a content comparison
  // because setContent() fires onUpdate, and an unguarded effect would loop: set →
  // update → parent state changes → effect → set.
  useEffect(() => {
    if (!editor) return;
    const next = value ?? EMPTY;
    if (JSON.stringify(editor.getJSON()) === JSON.stringify(next)) return;
    editor.commands.setContent(asEditorContent(next), { emitUpdate: false });
  }, [editor, value]);

  if (!editor) return <div className="rich rich--loading">Loading the editor…</div>;

  // The prototype's .rich bar: each button says what it does (its name), and a pressed
  // one says so (aria-pressed), never by colour alone.
  const button = (
    key: string,
    text: string,
    isActive: boolean | null,
    run: () => void,
    title: string,
  ) => (
    <button
      key={key}
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={isActive ?? undefined}
      onClick={() => run()}
    >
      {text}
    </button>
  );

  return (
    <div className="rich">
      <div className="rich__bar" role="toolbar" aria-label={`${label} formatting`}>
        {button(
          'b',
          'B',
          editor.isActive('bold'),
          () => editor.chain().focus().toggleBold().run(),
          'Bold',
        )}
        {button(
          'i',
          'I',
          editor.isActive('italic'),
          () => editor.chain().focus().toggleItalic().run(),
          'Italic',
        )}
        {button(
          'h2',
          'H2',
          editor.isActive('heading', { level: 2 }),
          () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
          'Heading level 2',
        )}
        {button(
          'h3',
          'H3',
          editor.isActive('heading', { level: 3 }),
          () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
          'Heading level 3',
        )}
        {button(
          'ul',
          '• List',
          editor.isActive('bulletList'),
          () => editor.chain().focus().toggleBulletList().run(),
          'Bulleted list',
        )}
        {button(
          'ol',
          '1. List',
          editor.isActive('orderedList'),
          () => editor.chain().focus().toggleOrderedList().run(),
          'Numbered list',
        )}
        {button(
          'quote',
          'Quote',
          editor.isActive('blockquote'),
          () => editor.chain().focus().toggleBlockquote().run(),
          'Block quote',
        )}
        {button(
          'code',
          'Code',
          editor.isActive('codeBlock'),
          () => editor.chain().focus().toggleCodeBlock().run(),
          'Code block',
        )}
        {button(
          'hr',
          'Rule',
          null,
          () => editor.chain().focus().setHorizontalRule().run(),
          'Horizontal rule',
        )}
        {LinkDialog && (
          <button
            type="button"
            title="Link"
            aria-label="Link"
            aria-pressed={editor.isActive('link')}
            onClick={() => {
              const href: unknown = editor.getAttributes('link')['href'];
              setLinking({ href: typeof href === 'string' ? href : '' });
            }}
          >
            <Glyph name="link" />
          </button>
        )}
        <button
          type="button"
          className="rich__clear"
          title="Clear formatting"
          aria-label="Clear formatting"
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
        >
          Clear
        </button>
      </div>
      <EditorContent editor={editor} />
      {LinkDialog && (
        <LinkDialog
          open={linking !== null}
          href={linking?.href ?? ''}
          label={`Link in ${label}`}
          onClose={() => setLinking(null)}
          onRemove={() => {
            editor.chain().focus().extendMarkRange('link').unsetLink().run();
            setLinking(null);
          }}
          onSave={(href) => {
            if (editor.state.selection.empty && !editor.isActive('link')) {
              // Nothing selected: the address itself becomes the linked words.
              editor
                .chain()
                .focus()
                .insertContent({
                  type: 'text',
                  text: href,
                  marks: [{ type: 'link', attrs: { href } }],
                })
                .run();
            } else {
              editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
            }
            setLinking(null);
          }}
        />
      )}
    </div>
  );
}
