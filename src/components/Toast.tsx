import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import styled, { css, type DefaultTheme } from 'styled-components'
import { useT } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'

/**
 * Toasts (DESIGN.md §5.5): success, error and info, bottom right on a desktop and bottom centre
 * on a phone, at most three stacked with the newest at the bottom. Success and info go away after
 * four seconds (paused while hovered or focused); errors stay until closed. Success and info are
 * `role="status"`, errors `role="alert"`, so screen readers announce them.
 */

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastOptions {
  /** Milliseconds before it closes itself; `null` keeps it until closed. Errors default to `null`, the rest to 4000. */
  timeout?: number | null
}

export interface ToastApi {
  show: (kind: ToastKind, message: ReactNode, options?: ToastOptions) => void
  success: (message: ReactNode, options?: ToastOptions) => void
  error: (message: ReactNode, options?: ToastOptions) => void
  info: (message: ReactNode, options?: ToastOptions) => void
  dismiss: (id: number) => void
}

interface Item {
  id: number
  kind: ToastKind
  message: ReactNode
  timeout: number | null
}

const MAX = 3
export const TOAST_TIMEOUT = 4000

const noop = () => {}
const fallback: ToastApi = { show: noop, success: noop, error: noop, info: noop, dismiss: noop }
const ToastContext = createContext<ToastApi>(fallback)

/** The toast functions; outside a ToastProvider they do nothing */
// oxlint-disable-next-line react/only-export-components
export function useToast(): ToastApi {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([])
  const next = useRef(1)

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((i) => i.id !== id)), [])

  const api = useMemo<ToastApi>(() => {
    const show = (kind: ToastKind, message: ReactNode, options?: ToastOptions) => {
      const timeout = options?.timeout !== undefined ? options.timeout : kind === 'error' ? null : TOAST_TIMEOUT
      const id = next.current++
      setItems((list) => [...list, { id, kind, message, timeout }].slice(-MAX))
    }
    return {
      show,
      success: (m, o) => show('success', m, o),
      error: (m, o) => show('error', m, o),
      info: (m, o) => show('info', m, o),
      dismiss,
    }
  }, [dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Stack>
        {items.map((item) => (
          <ToastItem key={item.id} item={item} onClose={() => dismiss(item.id)} />
        ))}
      </Stack>
    </ToastContext.Provider>
  )
}

const icons = { success: CircleCheck, error: CircleAlert, info: Info }

function ToastItem({ item, onClose }: { item: Item; onClose: () => void }) {
  const t = useT()
  const [paused, setPaused] = useState(false)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })

  useEffect(() => {
    if (item.timeout === null || paused) return
    const timer = setTimeout(() => close.current(), item.timeout)
    return () => clearTimeout(timer)
  }, [item.timeout, paused])

  const Icon = icons[item.kind]
  return (
    <Box
      $kind={item.kind}
      role={item.kind === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon size={18} aria-hidden />
      <Text>{item.message}</Text>
      <Close type="button" onClick={onClose} aria-label={t.close} title={t.close}>
        <X size={16} aria-hidden />
      </Close>
    </Box>
  )
}

const Stack = styled.div`
  position: fixed;
  right: ${({ theme }) => theme.space(6)};
  bottom: ${({ theme }) => theme.space(6)};
  z-index: 60;
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
  width: min(380px, calc(100vw - 32px));
  pointer-events: none;

  &:empty {
    display: none;
  }

  ${mobile} {
    right: 50%;
    bottom: ${({ theme }) => theme.space(4)};
    transform: translateX(50%);
  }
`

const tone = (kind: ToastKind, theme: DefaultTheme) =>
  kind === 'success' ? theme.colors.success : kind === 'error' ? theme.colors.danger : theme.colors.primary

const Box = styled.div<{ $kind: ToastKind }>`
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: ${({ theme }) => theme.space(2)};
  padding: 10px 8px 10px 12px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-left: 4px solid ${({ $kind, theme }) => tone($kind, theme)};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  box-shadow: ${({ theme }) => theme.shadowRaised};
  pointer-events: auto;

  & > svg {
    margin-top: 3px;
    color: ${({ $kind, theme }) => tone($kind, theme)};
  }

  ${({ $kind }) =>
    $kind === 'error' &&
    css`
      font-weight: 600;
    `}
`

const Text = styled.div`
  min-width: 0;
  font-size: ${({ theme }) => theme.type.body.size};
  line-height: ${({ theme }) => theme.type.body.line};
  overflow-wrap: anywhere;
`

const Close = styled.button`
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: transparent;
  color: ${({ theme }) => theme.colors.textMuted};

  &:hover {
    background: ${({ theme }) => theme.colors.surfaceAlt};
    color: ${({ theme }) => theme.colors.text};
  }
`
