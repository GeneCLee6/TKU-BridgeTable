import { Eye, EyeOff } from 'lucide-react'
import { useState, type InputHTMLAttributes } from 'react'
import styled from 'styled-components'
import { useT } from '../state/PreferencesContext.tsx'
import { inputStyles } from '../styles/controls.ts'
import type { ControlSize } from '../styles/tokens.ts'

/**
 * A password field with a button that shows or hides what was typed. The field itself is the
 * browser's own `type="password"` with the shared input look: the same font size as every other
 * field, no letter-spacing, no enlarged dots.
 */
export function PasswordInput({
  $size,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { $size?: ControlSize }) {
  const t = useT()
  const [shown, setShown] = useState(false)
  return (
    <Wrap>
      <Field {...props} $size={$size} type={shown ? 'text' : 'password'} />
      <Toggle
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? t.hidePassword : t.showPassword}
        aria-pressed={shown}
        title={shown ? t.hidePassword : t.showPassword}
      >
        {shown ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
      </Toggle>
    </Wrap>
  )
}

const Wrap = styled.span`
  position: relative;
  display: grid;
`

const Field = styled.input<{ $size?: ControlSize }>`
  ${inputStyles}
  padding-right: 44px;
`

const Toggle = styled.button`
  position: absolute;
  top: 50%;
  right: 4px;
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  transform: translateY(-50%);
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: transparent;
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;

  &:hover {
    color: ${({ theme }) => theme.colors.text};
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }
`
