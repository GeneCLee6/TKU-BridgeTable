import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import styled, { css } from 'styled-components'
import { formatCount } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * Filter chips and tabs with counts (DESIGN.md §7.10, 社長 2026-10-27): one row that never wraps.
 * When the chips don't fit (a phone, many tags) the row scrolls sideways, snapping to a chip, with
 * no scrollbar and a fade on the side that has more; the chosen chip is scrolled into view. Each
 * chip is a filled pill of one height with its label centred, and a count is a badge of tabular
 * figures with a minimum width, written compactly (`formatCount`), so a count growing from 5 to
 * 1000 doesn't push the other chips about.
 */

const FADE = '24px'

const Strip = styled.div<{ $fade: Fade }>`
  /* The chips' offsetLeft is from here */
  position: relative;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
  /* Snap a chip to the edge of the padding, not into it (which would fade the first chip) */
  scroll-padding-inline: 3px;
  scrollbar-width: none;
  /* Room for the focus ring, which the scrolling box would otherwise clip */
  padding: 3px;
  margin: -3px;
  &::-webkit-scrollbar {
    display: none;
  }

  ${({ $fade, theme }) => {
    // A mask only uses the alpha, so any opaque token does
    const solid = theme.colors.text
    const start = $fade === 'start' || $fade === 'both' ? `transparent, ${solid} ${FADE}` : solid
    const end =
      $fade === 'end' || $fade === 'both' ? `${solid} calc(100% - ${FADE}), transparent` : solid
    return (
      $fade !== 'none' &&
      css`
        mask-image: linear-gradient(to right, ${start}, ${end});
      `
    )
  }}
`

type Fade = 'none' | 'start' | 'end' | 'both'

/** The row of chips: `role="tablist"` for tabs, `role="group"` for toggles */
export function ChipStrip({
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<Fade>('none')

  useLayoutEffect(() => {
    const strip = ref.current
    if (!strip) return
    const update = () => {
      const more = strip.scrollWidth - strip.clientWidth
      const before = strip.scrollLeft > 4
      const after = strip.scrollLeft < more - 4
      setFade(before && after ? 'both' : before ? 'start' : after ? 'end' : 'none')
    }
    update()
    strip.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(strip)
    return () => {
      strip.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [])

  // A newly chosen chip in view, without scrolling the page
  const shown = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const strip = ref.current
    const chosen = strip?.querySelector<HTMLElement>(
      '[aria-selected="true"], [aria-pressed="true"]',
    )
    if (!strip || !chosen || chosen === shown.current) return
    shown.current = chosen
    const left = chosen.offsetLeft
    const right = left + chosen.offsetWidth
    if (left < strip.scrollLeft) strip.scrollLeft = left - 8
    else if (right > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = right - strip.clientWidth + 8
  })

  return (
    <Strip ref={ref} $fade={fade} {...props}>
      {children}
    </Strip>
  )
}

/** A chip: a pill toggle or tab, filled with `primary` when chosen */
export const Chip = styled.button<{ $active: boolean }>`
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  max-width: 240px;
  padding: 0 14px;
  border: 1px solid ${({ theme }) => theme.colors.borderStrong};
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  scroll-snap-align: start;
  cursor: pointer;

  &:hover {
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }
  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.focus};
    outline-offset: 1px;
  }
  ${({ $active, theme }) =>
    $active &&
    css`
      border-color: ${theme.colors.primary};
      background: ${theme.colors.primary};
      color: ${theme.colors.onPrimary};
      &:hover {
        background: ${theme.colors.primaryHover};
      }
    `}
`

/** A label that can be long (a tag), cut with … */
export const ChipLabel = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
`

const Count = styled.span`
  flex: none;
  min-width: 24px;
  height: 20px;
  padding: 0 6px;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.surfaceAlt};
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 12px;
  font-weight: 700;
  line-height: 20px;
  text-align: center;
  font-variant-numeric: tabular-nums;

  button[aria-selected='true'] > &,
  button[aria-pressed='true'] > &,
  button[aria-expanded='true'] > & {
    background: ${({ theme }) => theme.colors.onPrimary};
    color: ${({ theme }) => theme.colors.primary};
  }
`

/**
 * A chip's count as a badge: 5, 1234, 1.2萬 (the full number in `title`). The space before it is
 * not drawn (the chip is a flex box) but keeps the name read out as 「叫牌 5」, not 「叫牌5」.
 */
export function ChipCount({ n }: { n: number }) {
  const { lang } = usePreferences()
  const short = formatCount(n, lang)
  return (
    <>
      {' '}
      <Count title={short === String(n) ? undefined : n.toLocaleString()}>{short}</Count>
    </>
  )
}

/**
 * Two or three choices that are one setting (我的｜全社, 依日期｜依主題｜不分組): a segmented
 * control of equal parts on one line, never wrapping into a broken oval; a label too long for its
 * part (another language, a phone) is cut with …
 */
export const Segmented = styled.div`
  display: inline-grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  max-width: 100%;
  border: 1px solid ${({ theme }) => theme.colors.borderStrong};
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.surface};
  overflow: hidden;
`

export const SegmentButton = styled.button<{ $active: boolean; $small?: boolean }>`
  min-width: 0;
  height: ${({ $small }) => ($small ? '32px' : '36px')};
  padding: 0 ${({ $small }) => ($small ? '12px' : '16px')};
  border: 0;
  background: transparent;
  color: ${({ theme }) => theme.colors.text};
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;

  & + & {
    border-left: 1px solid ${({ theme }) => theme.colors.border};
  }
  &:hover {
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }
  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.focus};
    outline-offset: -2px;
  }
  ${({ $active, theme }) =>
    $active &&
    css`
      background: ${theme.colors.primary};
      color: ${theme.colors.onPrimary};
      &:hover {
        background: ${theme.colors.primaryHover};
      }
    `}
`
