import { useRef, type ChangeEvent, type CompositionEvent, type InputHTMLAttributes } from 'react'
import { toHalfWidth } from '../../shared/halfwidth.ts'

export type HalfWidthHandlers = Pick<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'onCompositionStart' | 'onCompositionEnd'>

/**
 * What a sign-in name, password, code or email field needs (社長 2026-11-03, shared/halfwidth.ts):
 * hints that it is English-like text (no capitals, autocorrect or spell check), and full-width
 * ASCII made half-width as the member types, so ＡＢＣ１２３ from a Chinese or Japanese input method
 * in full-width mode lands as ABC123. While the input method is composing nothing is touched (that
 * would break its candidate window); the text is converted when the composition ends and on every
 * other change. The field's own value is converted before `onChange` sees it, with the caret kept
 * (each character maps to one), so the form's state only ever holds the half-width text.
 */
export function useHalfWidth({ onChange, onCompositionStart, onCompositionEnd }: HalfWidthHandlers) {
  const composing = useRef(false)

  /** Rewrites the field's value in place; true when it changed */
  const convert = (field: HTMLInputElement) => {
    const half = toHalfWidth(field.value)
    if (half === field.value) return false
    // An email field has no selection API (selectionStart is null there)
    const start = field.selectionStart
    const end = field.selectionEnd
    field.value = half
    if (start !== null && end !== null) field.setSelectionRange(start, end)
    return true
  }

  return {
    lang: 'en',
    autoCapitalize: 'off',
    autoCorrect: 'off',
    spellCheck: false,
    onCompositionStart: (event: CompositionEvent<HTMLInputElement>) => {
      composing.current = true
      onCompositionStart?.(event)
    },
    onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => {
      composing.current = false
      onCompositionEnd?.(event)
      // Chrome sends the last input event before compositionend: that one was left alone, so the
      // form hears the converted text now. The native setter is bypassed by React's own value
      // tracking, so the input event below reaches onChange
      const field = event.currentTarget
      const before = field.value
      if (toHalfWidth(before) === before) return
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(field, toHalfWidth(before))
      field.dispatchEvent(new Event('input', { bubbles: true }))
    },
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const native = event.nativeEvent as InputEvent
      if (!composing.current && !native.isComposing) convert(event.target)
      onChange?.(event)
    },
  } as const
}
