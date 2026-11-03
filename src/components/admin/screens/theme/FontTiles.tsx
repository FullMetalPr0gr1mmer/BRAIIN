import { useId } from 'react';
import type { FontScript } from '@theme/fonts';
import { fontOptions } from './model';

// One group of the Fonts card (Admin v2 E13; the prototype's font tiles, screens_ops.js): the
// font catalogue's families for one script, each a tile with its name, its licence and a sample
// drawn in the family itself ("Aa", "أب"). Native radios in a fieldset, as the kit's Segmented:
// the group's name is the legend, the arrow keys and the checked state are the browser's own,
// and the label shows the state (public/styles/admin/theme.css). The sample is SVG text whose
// font is an attribute (no style attribute, ui.md §1.6); admin.css declares every family of the
// catalogue, so the sample is the real face. While owner item O-21 is open each group has the
// brand's family alone, chosen.

export interface FontTilesProps {
  script: FontScript;
  /** The group's name, shown as its legend. */
  label: string;
  value: string;
  onChange: (id: string) => void;
}

export default function FontTiles({ script, label, value, onChange }: FontTilesProps) {
  const name = useId();
  const options = fontOptions(script);
  return (
    <fieldset className="theme__fonts" data-script={script}>
      <legend className="theme__label">{label}</legend>
      <div className="theme__tiles">
        {options.map((option) => (
          <label key={option.value} className="theme__font" data-font={option.value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <svg
              className="theme__sample"
              viewBox="0 0 64 36"
              width="64"
              height="36"
              aria-hidden="true"
            >
              <text
                x={script === 'arabic' ? 62 : 2}
                y="28"
                fontSize="26"
                fontWeight="700"
                fontFamily={option.stack}
                fill="currentColor"
                textAnchor={script === 'arabic' ? 'end' : 'start'}
                direction={script === 'arabic' ? 'rtl' : 'ltr'}
              >
                {option.sample}
              </text>
            </svg>
            <span className="theme__font-name">
              <b>{option.name}</b>{' '}
              <span className="admin-sub">
                {option.brand ? `The brand's font. ${option.licence}` : option.licence}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
