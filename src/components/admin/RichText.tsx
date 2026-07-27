import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';
import type { JSONContent } from '@tiptap/core';
import type { TiptapDoc } from '@schemas/tiptap';

// Tiptap island. The ONLY hydrated React on the admin, which is why the vendor chunk
// carrying it is quarantined by name in astro.config.mjs — see the `manualChunks` note
// there for why the public 100 KB budget would otherwise start measuring this.
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

export default function RichText({ value, onChange, label, locale = 'en' }: RichTextProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // The renderer clamps headings to h2–h6 (the page's h1 is the entity title), so
        // offering h1 in the toolbar would silently demote it and confuse the author.
        heading: { levels: [2, 3, 4] },
      }),
    ],
    content: asEditorContent(value ?? EMPTY),
    // Astro renders islands on the server first; Tiptap must not try to measure a DOM
    // that does not exist yet.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'tiptap',
        dir: locale === 'ar' ? 'rtl' : 'ltr',
        lang: locale,
        'aria-label': label,
        role: 'textbox',
        'aria-multiline': 'true',
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

  if (!editor) return <div className="editor-surface">Loading editor…</div>;

  const button = (key: string, text: string, isActive: boolean, run: () => void, title: string) => (
    <button key={key} type="button" title={title} aria-pressed={isActive} onClick={() => run()}>
      {text}
    </button>
  );

  return (
    <div className="editor-surface">
      <div className="editor-toolbar" role="toolbar" aria-label={`${label} formatting`}>
        {button(
          'b',
          'Bold',
          editor.isActive('bold'),
          () => editor.chain().focus().toggleBold().run(),
          'Bold',
        )}
        {button(
          'i',
          'Italic',
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
          '—',
          false,
          () => editor.chain().focus().setHorizontalRule().run(),
          'Horizontal rule',
        )}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
