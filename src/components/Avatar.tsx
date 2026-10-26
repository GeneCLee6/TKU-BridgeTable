import { useState } from 'react'
import styled from 'styled-components'
import { avatarUrl } from '../../shared/avatar.ts'
import type { PublicUser } from '../../shared/protocol.ts'
import { avatarInitials, avatarSlot } from '../lib/avatar.ts'
import { useLobby } from '../state/ClubContext.tsx'

/**
 * A member's avatar: their uploaded picture (e1-t34) when they have one, otherwise (and while it
 * loads, or when it fails) their initial on their own colour (e1-t18). Decorative, since the name
 * is always next to it: the initial is drawn by CSS and the picture has no alt text, so neither is
 * read out nor part of the text.
 *
 * The picture's version comes from `avatar` when the caller has it (its own account, a profile
 * card), otherwise from the lobby's member list, so every place that shows a member (name plates,
 * the People tab, direct messages) picks up a new picture as soon as the lobby says so.
 */

const Circle = styled.span<{ $size: number; $id: string }>`
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  overflow: hidden;
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

const Picture = styled.img`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
`

/** Each lobby's member list as a map, built once per list however many avatars read it */
const versionsOf = new WeakMap<PublicUser[], Map<string, number>>()
function lobbyVersion(members: PublicUser[] | undefined, id: string): number | undefined {
  if (!members) return undefined
  let versions = versionsOf.get(members)
  if (!versions) {
    versions = new Map(members.flatMap((m) => (m.avatar ? [[m.id, m.avatar] as const] : [])))
    versionsOf.set(members, versions)
  }
  return versions.get(id)
}

export function Avatar({ id, name, size = 32, avatar }: { id: string; name: string; size?: number; avatar?: number }) {
  const members = useLobby()?.members
  const version = avatar ?? lobbyVersion(members, id)
  const src = version ? avatarUrl(id, version) : null
  // The address that failed to load; a new version tries again
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <Circle $size={size} $id={id} aria-hidden data-avatar data-initials={avatarInitials(name)}>
      {src && failed !== src && (
        <Picture src={src} alt="" width={size} height={size} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(src)} />
      )}
    </Circle>
  )
}
