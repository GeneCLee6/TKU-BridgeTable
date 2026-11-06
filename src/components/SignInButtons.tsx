import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styled, { css } from 'styled-components'
import type { OAuthName } from '../../shared/protocol.ts'

/**
 * The sign-in buttons of other sites (e1-t31 Google, e1-t32 LINE; DESIGN.md §7.11), drawn as their
 * brand guidelines ask: Google's white button with a gray edge and the four-colour "G" (dark in the
 * dark theme), LINE's green one with the white LINE logo. Both put the logo 10 left of the words and centre
 * the pair, with the same height and radius, so the two stacked buttons look like a matched pair.
 * The logos are inline SVG (the CSP lets in nothing from other sites); the colours are
 * `theme.brands`. Used on the sign-in page, the application form and "My account"
 */

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  provider: OAuthName
  /** Working: the button can't be pressed again */
  busy?: boolean
  /** As wide as its words (a card's footer) instead of the whole form's width */
  inline?: boolean
  children: ReactNode
}

export function SignInButton({ provider, busy = false, inline = false, disabled, children, type = 'button', ...rest }: Props) {
  const Shell = provider === 'google' ? GoogleShell : LineShell
  return (
    <Shell {...rest} type={type} disabled={disabled || busy} aria-busy={busy || undefined} $inline={inline}>
      {provider === 'google' ? <GoogleLogo /> : <LineLogo />}
      <Label>{children}</Label>
    </Shell>
  )
}

/** Google's "G", in its four colours on any background */
export function GoogleLogo() {
  return (
    <Logo viewBox="0 0 48 48" aria-hidden="true" focusable="false" $google>
      <path
        className="r"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        className="b"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        className="y"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        className="g"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </Logo>
  )
}

/** LINE's logo: the white speech bubble, the word cut out of it so the green shows through */
export function LineLogo() {
  return (
    <Logo viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"
      />
    </Logo>
  )
}

const Logo = styled.svg<{ $google?: boolean }>`
  flex: none;
  width: 20px;
  height: 20px;
  ${({ $google, theme }) =>
    $google &&
    css`
      .r {
        fill: ${theme.brands.googleLogo.red};
      }
      .b {
        fill: ${theme.brands.googleLogo.blue};
      }
      .y {
        fill: ${theme.brands.googleLogo.yellow};
      }
      .g {
        fill: ${theme.brands.googleLogo.green};
      }
    `}
`

const Label = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

/** What both share: 40 high, full width in a form, the focus ring of every button, dimmed when off */
const shell = css<{ $inline: boolean }>`
  position: relative;
  display: flex;
  align-items: center;
  width: ${({ $inline }) => ($inline ? 'auto' : '100%')};
  min-height: ${({ theme }) => theme.controlHeight.md};
  font-family: Roboto, ${({ theme }) => theme.fonts.body};
  font-size: 14px;
  line-height: 20px;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.focus};
    outline-offset: 2px;
  }

  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
`

/** Google's button: white (dark in the dark theme), gray edge, radius 4, padding 12, 10 between the "G" and the words */
const GoogleShell = styled.button<{ $inline: boolean }>`
  ${shell}
  justify-content: center;
  gap: 10px;
  padding: 0 12px;
  border: 1px solid ${({ theme }) => theme.brands.google.border};
  border-radius: 4px;
  background: ${({ theme }) => theme.brands.google.bg};
  color: ${({ theme }) => theme.brands.google.text};
  font-weight: 500;

  &:hover:not(:disabled) {
    background-image: linear-gradient(${({ theme }) => theme.brands.google.hover}, ${({ theme }) => theme.brands.google.hover});
  }

  &:active:not(:disabled) {
    background-image: linear-gradient(${({ theme }) => theme.brands.google.pressed}, ${({ theme }) => theme.brands.google.pressed});
  }
`

/** LINE's button: LINE green, laid out like Google's (logo 10 left of the words, the pair centred) so the two match */
const LineShell = styled.button<{ $inline: boolean }>`
  ${shell}
  justify-content: center;
  gap: 10px;
  padding: 0 12px;
  border: 0;
  border-radius: 4px;
  background: ${({ theme }) => theme.brands.line.bg};
  color: ${({ theme }) => theme.brands.line.text};
  font-weight: 700;

  &:hover:not(:disabled) {
    background-image: linear-gradient(${({ theme }) => theme.brands.line.hover}, ${({ theme }) => theme.brands.line.hover});
  }

  &:active:not(:disabled) {
    background-image: linear-gradient(${({ theme }) => theme.brands.line.pressed}, ${({ theme }) => theme.brands.line.pressed});
  }
`
