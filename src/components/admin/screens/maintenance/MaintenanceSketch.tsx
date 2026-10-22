// "What visitors see" (Admin v2 U9b; the prototype's drawPv): a small drawing of the
// maintenance page from the values on screen, so an editor sees a change before saving it.
// Class-based (the background is a `data-bg` bucket, no style attribute), English only; the
// real page in both languages is "Preview full screen". The built-in words are the page's own
// (src/lib/maintenance/copy.ts), so the drawing never says something the page would not.

import { DEFAULT_MESSAGE, DEFAULT_TITLE, MONTH_WORDS } from '@/lib/maintenance/copy';

type Values = Readonly<Record<string, unknown>>;

/** "3 November" from '2026-11-03' (the page's own month words), or ''. */
export function dayWords(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  const month = m ? MONTH_WORDS.en[Number(m[1]) - 1] : undefined;
  return m && month ? `${Number(m[2])} ${month}` : '';
}

const textOf = (value: unknown): string => {
  if (!value || typeof value !== 'object') return '';
  const en = (value as { en?: unknown }).en;
  return typeof en === 'string' ? en.trim() : '';
};

export default function MaintenanceSketch({ values }: { values: Values }) {
  const showContact = values['showContact'] === true;
  const title = textOf(values['title']) || DEFAULT_TITLE.en;
  const message =
    textOf(values['message']) ||
    (showContact ? DEFAULT_MESSAGE.emailAndWhatsapp.en : DEFAULT_MESSAGE.none.en);
  const until = typeof values['until'] === 'string' ? values['until'] : '';
  const showDate = values['showDate'] === true && dayWords(until) !== '';
  return (
    <div
      className="mnt-sketch"
      data-bg={values['background'] === 'black' ? 'black' : 'image'}
      role="img"
      aria-label={`The maintenance page: ${title}`}
    >
      <span className="mnt-sketch__logo" aria-hidden="true" />
      <b className="mnt-sketch__t">{title}</b>
      <span className="mnt-sketch__m">{message}</span>
      {showDate && <span className="mnt-sketch__d">Back on {dayWords(until)}</span>}
      {showContact && (
        <span className="mnt-sketch__c">
          <span className="mnt-sketch__b" data-primary="">
            Email us
          </span>
          <span className="mnt-sketch__b">WhatsApp</span>
        </span>
      )}
    </div>
  );
}
