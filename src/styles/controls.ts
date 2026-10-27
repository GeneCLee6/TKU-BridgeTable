import { css } from 'styled-components'
import { mobile, type ControlSize } from './tokens.ts'

/**
 * The look every text field shares (DESIGN.md §5.2): the same heights as the buttons, the same
 * font size whatever the type (a password field is the browser's own `type="password"`, with no
 * letter-spacing or bigger dots), a primary outline and focus halo, a red edge when `aria-invalid`.
 */
export const inputStyles = css<{ $size?: ControlSize }>`
  width: 100%;
  min-height: ${({ theme, $size }) => theme.controlHeight[$size ?? 'md']};
  padding: 0 12px;
  border: 1px solid ${({ theme }) => theme.colors.borderStrong};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-family: inherit;
  font-size: ${({ $size }) => ($size === 'lg' ? '16px' : '15px')};
  font-weight: 400;
  letter-spacing: normal;
  line-height: 1.4;

  /* At least 16px on a phone, or iOS zooms in on focus */
  ${mobile} {
    font-size: 16px;
  }

  &::placeholder {
    color: ${({ theme }) => theme.colors.textMuted};
  }

  &:focus,
  &:focus-visible {
    outline: none;
    border-color: ${({ theme }) => theme.colors.primary};
    box-shadow: 0 0 0 3px color-mix(in srgb, ${({ theme }) => theme.colors.focus} 35%, transparent);
  }

  &[aria-invalid='true'] {
    border-color: ${({ theme }) => theme.colors.danger};
    box-shadow: inset 0 0 0 1px ${({ theme }) => theme.colors.danger};
  }

  &:disabled {
    background: ${({ theme }) => theme.colors.surfaceAlt};
    color: ${({ theme }) => theme.colors.textMuted};
  }
`

/**
 * A dialog panel's height and scrolling: the visible window (dvh leaves out iOS's toolbar) less
 * the backdrop's padding (`Modal.tsx`). A panel taller than that scrolls inside itself, and a swipe
 * that reaches its end does not pass on to the page.
 */
export const panelScroll = css`
  max-height: calc(100vh - 32px);
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  overscroll-behavior: contain;
`
