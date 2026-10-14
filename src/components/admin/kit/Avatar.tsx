import { avatarTone, initialsOf } from '@/lib/admin/avatar';

// An avatar inside islands (Admin v2 F4b): the markup of ui/Avatar.astro. Two letters on
// one of eight audited tones, picked by a stable hash of `toneKey` (the person's id);
// decorative beside a name unless `label` names it.

export interface AvatarProps {
  name?: string | null | undefined;
  email?: string | undefined;
  initials?: string | undefined;
  toneKey?: string | undefined;
  size?: 'sm' | 'lg' | undefined;
  label?: string | undefined;
}

export default function Avatar({
  name = null,
  email = '',
  initials,
  toneKey,
  size,
  label,
}: AvatarProps) {
  return (
    <span
      className="avatar"
      data-tone={toneKey === undefined ? undefined : avatarTone(toneKey)}
      data-size={size}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
    >
      {initials ?? initialsOf(name, email)}
    </span>
  );
}
