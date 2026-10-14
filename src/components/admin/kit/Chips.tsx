import { formatNumber } from '@/lib/admin/charts';

// Chips (Admin v2 F4b, the prototype's .chip): toggle buttons in a named group, each
// aria-pressed. A filter behaves as radios (`multiple` false, the default): pressing a
// chip presses it alone, and pressing the pressed one changes nothing, so a filter is
// never left with no choice. Tags behave as toggles (`multiple`). A count is part of the
// chip's name ("Draft 12"). Filters that change the URL are links (ui/LinkChips.astro).

export interface ChipDef<T extends string> {
  value: T;
  label: string;
  count?: number | undefined;
}

export interface ChipsProps<T extends string> {
  /** The group's name ("Filter by status"). */
  label: string;
  chips: readonly ChipDef<T>[];
  selected: readonly T[];
  onChange: (selected: T[]) => void;
  multiple?: boolean;
}

/** The selection after pressing `value`: alone (a filter) or toggled (tags). */
export function nextSelection<T extends string>(
  selected: readonly T[],
  value: T,
  multiple: boolean,
): T[] {
  if (!multiple) return [value];
  return selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
}

export default function Chips<T extends string>({
  label,
  chips,
  selected,
  onChange,
  multiple = false,
}: ChipsProps<T>) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {chips.map((chip) => {
        const pressed = selected.includes(chip.value);
        return (
          <button
            key={chip.value}
            type="button"
            className="chip"
            aria-pressed={pressed}
            onClick={() => {
              if (pressed && !multiple) return;
              onChange(nextSelection(selected, chip.value, multiple));
            }}
          >
            {chip.label}
            {/* A space, so the count is its own word in the chip's name ("Draft 12"); the
                flex gap draws the space, the text node draws nothing. */}
            {chip.count !== undefined && ' '}
            {chip.count !== undefined && (
              <span className="chip__n">{formatNumber(chip.count)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
