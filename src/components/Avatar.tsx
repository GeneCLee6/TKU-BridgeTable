import styled from 'styled-components'
import { avatarInitials, avatarSlot } from '../lib/avatar.ts'

/**
 * A member's default avatar (e1-t18): their initial on their own colour. Decorative, since the name
 * is always next to it: the initial is drawn by CSS, so it is neither read out nor part of the text
 */

const Circle = styled.span<{ $size: number; $id: string }>`
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  border-radius: 50%;
  background: ${({ theme, $id }) => theme.avatars[avatarSlot($id, theme.avatars.length)]};
  color: ${({ theme }) => theme.onAvatar};
  font-size: ${({ $size }) => Math.round($size * 0.44)}px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0;
  user-select: none;

  &::before {
    content: attr(data-initials);
  }
`

export function Avatar({ id, name, size = 32 }: { id: string; name: string; size?: number }) {
  return <Circle $size={size} $id={id} aria-hidden data-avatar data-initials={avatarInitials(name)} />
}
