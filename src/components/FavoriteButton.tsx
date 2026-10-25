import { Star } from 'lucide-react'
import type { MouseEvent } from 'react'
import styled from 'styled-components'
import { setFavorite, useFavoriteIds } from '../lib/favorites.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { useToast } from './Toast.tsx'

/**
 * The star that keeps a board among the member's favorites (e4-t25, AC-4.4): on history rows, the
 * side panel's record, the result at the table and the record page. It shares one list of kept
 * boards with every other star (`src/lib/favorites.ts`) and does not open the row it sits in.
 */

const StarButton = styled.button<{ $on: boolean; $onFelt?: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: transparent;
  color: ${({ theme, $on, $onFelt }) => ($on ? ($onFelt ? theme.colors.accent : theme.colors.accentStrong) : 'inherit')};
  opacity: ${({ $on }) => ($on ? 1 : 0.7)};
  cursor: pointer;
  vertical-align: middle;

  &:hover:not(:disabled) {
    opacity: 1;
  }
  &:disabled {
    cursor: default;
    opacity: 0.35;
  }
  & > svg {
    fill: ${({ theme, $on }) => ($on ? theme.colors.accent : 'none')};
  }
`

export function FavoriteButton({ boardId, onFelt }: { boardId: string; onFelt?: boolean }) {
  const { t, message } = usePreferences()
  const toast = useToast()
  const ids = useFavoriteIds()
  const kept = ids?.has(boardId) ?? false
  const label = kept ? t.favoriteRemove : t.favoriteAdd

  const toggle = (event: MouseEvent) => {
    event.stopPropagation()
    setFavorite(boardId, !kept).catch((e) => toast.error(message(e.code, e.params, e.message)))
  }

  return (
    <StarButton
      type="button"
      $on={kept}
      $onFelt={onFelt}
      aria-pressed={kept}
      aria-label={label}
      title={label}
      disabled={!ids}
      onClick={toggle}
    >
      <Star size={18} aria-hidden />
    </StarButton>
  )
}
