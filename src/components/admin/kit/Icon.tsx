import { ICON_SPRITE, type IconName } from '@/lib/admin/icons';

// One icon from the admin sprite, for use inside islands. The same markup as Icon.astro:
// size is the width/height attributes (a style prop would render as a style="" that
// style-src refuses), decorative unless `label` names it.

export interface IconProps {
  name: IconName;
  size?: number;
  label?: string | undefined;
  className?: string | undefined;
}

export default function Icon({ name, size = 18, label, className }: IconProps) {
  return (
    <svg
      className={className ? `ic ${className}` : 'ic'}
      width={size}
      height={size}
      aria-hidden={label ? undefined : 'true'}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      <use href={`${ICON_SPRITE}#i-${name}`} />
    </svg>
  );
}
