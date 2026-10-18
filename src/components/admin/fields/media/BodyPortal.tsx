import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Renders its dialog at the end of <body> (Admin v2 U4, risk R2): the picker opens from
// inside an edit <form>, and the upload dialog from inside the picker. A <dialog> left in the
// form would let Enter in its search box submit the form (a modal dialog's content is still
// the form's descendant), and nesting the two dialogs in each other's markup would tie their
// focus and stacking together. In <body>, each is its own top-layer modal, Escape closes the
// top one only, and each returns focus to whatever opened it.
//
// Nothing renders on the server or before the island hydrates: the dialog opens on a press,
// so its markup is never part of the page's server HTML (and the server render and the first
// client render agree). Where there is no document at all (a test rendering to a string),
// the dialog renders in place, so its markup can still be checked.

export default function BodyPortal({ children }: { children: ReactNode }) {
  const [body, setBody] = useState<HTMLElement | null>(null);
  useEffect(() => setBody(document.body), []);
  if (typeof document === 'undefined') return <>{children}</>;
  return body ? createPortal(children, body) : null;
}
