import { Eye, EyeOff } from 'lucide-react'
import { useState, type InputHTMLAttributes } from 'react'
import styled from 'styled-components'
import { useT } from '../state/PreferencesContext.tsx'

/** A password field with a button that shows or hides what was typed */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const t = useT()
  const [shown, setShown] = useState(false)
  return (
    <Wrap>
      <input {...props} type={shown ? 'text' : 'password'} />
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

  & > input {
    min-height: 42px;
    padding: 0 44px 0 12px;
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    background: ${({ theme }) => theme.colors.bg};
    color: inherit;
    font-size: 16px;
    font-weight: 400;
  }
`

const Toggle = styled.button`
  position: absolute;
  top: 50%;
  right: 4px;
  display: inline-grid;
  place-items: center;
  width: 36px;
  height: 36px;
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
