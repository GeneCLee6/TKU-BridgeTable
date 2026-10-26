import { ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react'
import type { ButtonHTMLAttributes, HTMLAttributes } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import styled, { css, keyframes } from 'styled-components'
import { inputStyles } from '../styles/controls.ts'
import { mobile, type ControlSize } from '../styles/tokens.ts'

/** Shared building blocks for the chrome (lobby, history, forms). DESIGN.md §5 has the rules. */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps {
  /** `secondary` when left out. One `primary` per area; `danger` only on the confirming step. */
  $variant?: ButtonVariant
  /** `md` when left out */
  $size?: ControlSize
  /** @deprecated Use `$size="sm"` */
  $small?: boolean
  /** Working: a spinner before the label, and the button can't be pressed again */
  $busy?: boolean
}

const buttonFont = { sm: '13px', md: '15px', lg: '16px' } as const
const buttonPad = { sm: '12px', md: '16px', lg: '20px' } as const

const sizeOf = ({ $size, $small }: ButtonProps): ControlSize => $size ?? ($small ? 'sm' : 'md')

const spin = keyframes`
  to { transform: rotate(360deg); }
`

export const Button = styled.button.attrs<ButtonProps>(({ $busy, disabled }) => ({
  disabled: disabled || $busy,
  'aria-busy': $busy || undefined,
}))<ButtonProps>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: ${({ theme, ...p }) => theme.controlHeight[sizeOf(p)]};
  padding: 0 ${(p) => buttonPad[sizeOf(p)]};
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.borderStrong};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-size: ${(p) => buttonFont[sizeOf(p)]};
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
  text-decoration: none;
  transition:
    background 0.12s,
    border-color 0.12s;

  &:hover:not(:disabled) {
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }

  &:active:not(:disabled) {
    transform: translateY(1px);
  }

  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.focus};
    outline-offset: 2px;
  }

  &:disabled {
    opacity: 0.45;
    cursor: default;
  }

  ${({ $variant, theme }) =>
    $variant === 'primary' &&
    css`
      background: ${theme.colors.primary};
      border-color: ${theme.colors.primary};
      color: ${theme.colors.onPrimary};
      &:hover:not(:disabled) {
        background: ${theme.colors.primaryHover};
        border-color: ${theme.colors.primaryHover};
      }
    `}
  ${({ $variant, theme }) =>
    $variant === 'ghost' &&
    css`
      background: transparent;
      border-color: transparent;
      color: ${theme.colors.primary};
      &:hover:not(:disabled) {
        background: ${theme.colors.primarySoft};
      }
    `}
  ${({ $variant, theme }) =>
    $variant === 'danger' &&
    css`
      background: ${theme.colors.danger};
      border-color: ${theme.colors.danger};
      color: ${theme.colors.onDanger};
      &:hover:not(:disabled) {
        background: ${theme.colors.danger};
        filter: brightness(1.08);
      }
    `}

  ${({ $busy }) =>
    $busy &&
    css`
      &:disabled {
        opacity: 0.8;
      }
      &::before {
        content: '';
        flex: none;
        width: 1em;
        height: 1em;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: ${spin} 0.7s linear infinite;
      }
    `}
`

/** A text field. `type="password"` stays a plain password field (see `PasswordInput` for the eye button). */
export const Input = styled.input<{ $size?: ControlSize }>`
  ${inputStyles}
`

export const Select = styled.select<{ $size?: ControlSize }>`
  ${inputStyles}
  padding-right: 8px;
`

export const Textarea = styled.textarea<{ $size?: ControlSize }>`
  ${inputStyles}
  min-height: 96px;
  padding: 8px 12px;
  resize: vertical;
`

/** One form field: label, input, then a hint or an error, 6px apart */
export const Field = styled.div`
  display: grid;
  gap: 6px;
  min-width: 0;
`

export const FieldLabel = styled.label`
  color: ${({ theme }) => theme.colors.text};
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
`

export const FieldHint = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.type.small.size};
  line-height: ${({ theme }) => theme.type.small.line};
`

const FieldErrorText = styled.p`
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin: 0;
  color: ${({ theme }) => theme.colors.danger};
  font-size: ${({ theme }) => theme.type.small.size};
  font-weight: 600;
  line-height: ${({ theme }) => theme.type.small.line};

  & > svg {
    flex: none;
    margin-top: 3px;
  }
`

/** The error under one field; point the input's `aria-describedby` at its `id` and set `aria-invalid` */
export function FieldError({ children, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <FieldErrorText {...props}>
      <TriangleAlert size={14} aria-hidden />
      <span>{children}</span>
    </FieldErrorText>
  )
}

/**
 * A card. Used bare it is one padded block, as before. With `CardHeader` / `CardFooter` as its
 * first / last child it becomes the three-part card of DESIGN.md §5.3.
 */
export const Card = styled.section`
  --card-pad: ${({ theme }) => theme.space(6)};
  padding: var(--card-pad);
  border-radius: ${({ theme }) => theme.radius.lg};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surface};
  box-shadow: ${({ theme }) => theme.shadow};

  ${mobile} {
    --card-pad: ${({ theme }) => theme.space(4)};
  }
`

/** The card's title bar: an `h2` (CardTitle) and tools on the right, ruled off from the body */
export const CardHeader = styled.header`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space(3)};
  margin: calc(var(--card-pad) * -1) calc(var(--card-pad) * -1) var(--card-pad);
  padding: ${({ theme }) => theme.space(4)} var(--card-pad);
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
`

export const CardTitle = styled.h2`
  margin: 0;
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.type.h2.size};
  line-height: ${({ theme }) => theme.type.h2.line};
  font-weight: ${({ theme }) => theme.type.h2.weight};
`

/** The card's footer: `surfaceAlt`, buttons on the right (ghost 還原 + primary 儲存) */
export const CardFooter = styled.footer`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: ${({ theme }) => theme.space(2)};
  margin: var(--card-pad) calc(var(--card-pad) * -1) calc(var(--card-pad) * -1);
  padding: ${({ theme }) => theme.space(3)} var(--card-pad);
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 0 0 ${({ theme }) => theme.radius.lg} ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.surfaceAlt};
`

export const PageMain = styled.main`
  width: 100%;
  max-width: ${({ theme }) => theme.layout.contentMax};
  margin: 0 auto;
  padding: ${({ theme }) => theme.space(8)} 16px ${({ theme }) => theme.space(12)};
`

export const PageTitle = styled.h1`
  margin: 0 0 ${({ theme }) => theme.space(4)};
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.type.title.size};
  line-height: ${({ theme }) => theme.type.title.line};
  font-weight: ${({ theme }) => theme.type.title.weight};
`

export const Muted = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
`

/** A form-wide error (sign-in failed, connection lost): a red bar on the left, above the form */
export const ErrorText = styled.p`
  margin: 0;
  padding: 10px 12px;
  border-left: 4px solid ${({ theme }) => theme.colors.danger};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.dangerSoft};
  color: ${({ theme }) => theme.colors.danger};
  font-size: 14px;
  font-weight: 600;
`

const actionLinkStyle = css<{ $back?: boolean; $onPanel?: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-height: ${({ theme }) => theme.controlHeight.sm};
  padding: ${({ $back }) => ($back ? '0 10px 0 4px' : '0 4px 0 10px')};
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme, $onPanel }) => ($onPanel ? theme.table.bidRedouble : theme.colors.primary)};
  font-size: 14px;
  font-weight: 600;
  line-height: 1.2;
  text-decoration: none;
  transition: background 0.12s;

  & > svg {
    flex: none;
    transition: transform 0.12s;
  }

  &:hover {
    background: ${({ theme, $onPanel }) => ($onPanel ? theme.table.panelHover : theme.colors.primarySoft)};
    text-decoration: none;
  }
  &:hover > svg {
    transform: translateX(${({ $back }) => ($back ? '-2px' : '2px')});
  }

  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.focus};
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    &:hover > svg { transform: none; }
  }
`

const ActionLinkBase = styled(Link)<{ $back?: boolean; $onPanel?: boolean }>`
  ${actionLinkStyle}
`

const ActionButtonBase = styled.button<{ $back?: boolean; $onPanel?: boolean }>`
  ${actionLinkStyle}
  border: 0;
  background: none;
  cursor: pointer;
`

export interface ActionLinkProps extends LinkProps {
  /** A way back (to a list): the chevron points left, before the label */
  back?: boolean
  /** On the light result panel over the felt (`theme.table.panel`, light in both themes) */
  onPanel?: boolean
}

/**
 * A secondary action that goes somewhere: a ghost-button link with a chevron ("牌局紀錄 ›",
 * "‹ 所有挑戰"), instead of text with an arrow in it (DESIGN.md §7.1). Not for links in running text.
 */
export function ActionLink({ back, onPanel, children, ...props }: ActionLinkProps) {
  return (
    <ActionLinkBase $back={back} $onPanel={onPanel} {...props}>
      {back && <ChevronLeft size={16} aria-hidden />}
      <span>{children}</span>
      {!back && <ChevronRight size={16} aria-hidden />}
    </ActionLinkBase>
  )
}

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  back?: boolean
  onPanel?: boolean
}

/**
 * `ActionLink`'s look for a step inside the same view that is not an address of its own (the side
 * panel's "‹ 返回日期", e3-t48): the same ghost link with a chevron, as a button
 */
export function ActionButton({ back, onPanel, children, type = 'button', ...props }: ActionButtonProps) {
  return (
    <ActionButtonBase type={type} $back={back} $onPanel={onPanel} {...props}>
      {back && <ChevronLeft size={16} aria-hidden />}
      <span>{children}</span>
      {!back && <ChevronRight size={16} aria-hidden />}
    </ActionButtonBase>
  )
}
