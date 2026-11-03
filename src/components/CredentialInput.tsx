import type { InputHTMLAttributes } from 'react'
import { useHalfWidth } from '../lib/useHalfWidth.ts'
import type { ControlSize } from '../styles/tokens.ts'
import { Input } from './ui.tsx'

/**
 * A text field for a sign-in name, invite code, one-time code or email address: always half-width
 * (`useHalfWidth`). Pass `inputMode="email"` or `"numeric"` where that fits; the default is text
 */
export function CredentialInput({
  onChange,
  onCompositionStart,
  onCompositionEnd,
  inputMode = 'text',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { $size?: ControlSize }) {
  const halfWidth = useHalfWidth({ onChange, onCompositionStart, onCompositionEnd })
  return <Input {...props} {...halfWidth} inputMode={inputMode} />
}
