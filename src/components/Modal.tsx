import type { ComponentProps } from 'react'
import styled from 'styled-components'
import { useScrollLock } from '../lib/useScrollLock.ts'

/**
 * What every dialog shares: the dimmed backdrop, which locks the page's scrolling while it is
 * shown (`useScrollLock`). The panels take `panelScroll` (`styles/controls.ts`): a dialog taller
 * than the window scrolls inside itself; a swipe that reaches its end, or lands on the backdrop,
 * never scrolls the page.
 */

const Shade = styled.div`
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: ${({ theme }) => theme.colors.overlay};
  overscroll-behavior: contain;
`

export function Backdrop(props: ComponentProps<typeof Shade>) {
  useScrollLock()
  return <Shade {...props} />
}
