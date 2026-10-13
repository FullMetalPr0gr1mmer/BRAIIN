import { useId } from 'react';
import Icon from './Icon';
import type { IconName } from '@/lib/admin/icons';

// A segmented control (Admin v2 F4b, the prototype's .seg): one choice from a few, such as
// EN | العربية | Both or the 7 / 30 / 90-day range. Native radios in a fieldset, so the
// group's name (the legend), the arrow keys (mirrored in right-to-left text) and the
// checked state are the browser's own, not a script's; the label shows the state
// (admin.css). On a server screen the same choice is links (ui/LinkTabs.astro).

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName | undefined;
  /** The option's language, when its label is in another one (العربية). */
  lang?: string | undefined;
}

export interface SegmentedProps<T extends string> {
  /** The group's name, read as the fieldset's legend. */
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The radios' shared name; generated when left out. */
  name?: string | undefined;
}

export default function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  name,
}: SegmentedProps<T>) {
  const generated = useId();
  const group = name ?? generated;
  return (
    <fieldset className="seg">
      <legend className="visually-hidden">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="seg__o" lang={option.lang}>
          <input
            type="radio"
            name={group}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          {option.icon && <Icon name={option.icon} size={14} />}
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
