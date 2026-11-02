import { useEffect, useId, useState } from 'react'
import styled from 'styled-components'
import type { RatingPoint, RatingView } from '../../shared/rating.ts'
import { ApiError, api } from '../lib/api.ts'
import { formatDate } from '../lib/format.ts'
import { useAuth, useFeature } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Muted } from './ui.tsx'

/**
 * 實力評分 on a profile (`e9-t08`, AC-9.3, ARCHITECTURE.md §5.20): the member's rating, how many
 * events it rests on and its trend, a plain SVG line. A member who hides it shows only that it is
 * hidden (the server sends nothing more); on their own profile they choose. Only with the
 * `rankings` flag.
 */

const Wrap = styled.section`
  margin-top: ${({ theme }) => theme.space(4)};
`

const Title = styled.h3`
  margin: 0 0 ${({ theme }) => theme.space(2)};
  font-size: 15px;
  color: ${({ theme }) => theme.colors.text};
`

const Headline = styled.p`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: ${({ theme }) => theme.space(2)};
  margin: 0 0 ${({ theme }) => theme.space(2)};

  & > strong {
    font-size: 24px;
    font-variant-numeric: tabular-nums;
    color: ${({ theme }) => theme.colors.text};
  }
`

const Tag = styled.span`
  padding: 1px 8px;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.accentSoft};
  color: ${({ theme }) => theme.colors.accentStrong};
  font-size: 12px;
  font-weight: 700;
`

const Chart = styled.svg`
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;

  .grid {
    stroke: ${({ theme }) => theme.colors.border};
    stroke-width: 1;
  }
  .axis {
    fill: ${({ theme }) => theme.colors.textMuted};
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .line {
    fill: none;
    stroke: ${({ theme }) => theme.colors.primary};
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .dot {
    fill: ${({ theme }) => theme.colors.primary};
    stroke: ${({ theme }) => theme.colors.surface};
    stroke-width: 2;
  }
  .hit {
    fill: transparent;
  }
  .hit:hover + .dot,
  .hit:focus + .dot {
    r: 6;
  }
`

/** A table of the same points for screen readers */
const Hidden = styled.table`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`

const Toggle = styled.label`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  margin-top: ${({ theme }) => theme.space(2)};
  font-size: 14px;
`

const W = 320
const H = 120
const PAD = { left: 36, right: 8, top: 8, bottom: 18 }

/** The trend: a 2px line, a dot on each event, the lowest and highest ratings on the left */
export function TrendChart({ points, label }: { points: readonly RatingPoint[]; label: string }) {
  const { lang, t } = usePreferences()
  if (points.length < 2) return null
  const values = points.map((p) => p.rating)
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (hi - lo < 50) {
    const mid = (hi + lo) / 2
    lo = mid - 25
    hi = mid + 25
  }
  const x = (i: number) => PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right)
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rating).toFixed(1)}`).join(' ')
  return (
    <>
      <Chart viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {[hi, lo].map((v) => (
          <g key={v}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="axis" x={PAD.left - 4} y={y(v) + 4} textAnchor="end">
              {Math.round(v)}
            </text>
          </g>
        ))}
        <text className="axis" x={PAD.left} y={H - 2}>
          {formatDate(points[0].at, lang)}
        </text>
        <text className="axis" x={W - PAD.right} y={H - 2} textAnchor="end">
          {formatDate(points[points.length - 1].at, lang)}
        </text>
        <path className="line" d={path} />
        {points.map((p, i) => (
          <g key={p.eventId}>
            <circle className="hit" cx={x(i)} cy={y(p.rating)} r={10}>
              <title>{`${formatDate(p.at, lang)} · ${p.rating}`}</title>
            </circle>
            <circle className="dot" cx={x(i)} cy={y(p.rating)} r={4} pointerEvents="none" />
          </g>
        ))}
      </Chart>
      <Hidden>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th>{t.rating.date}</th>
            <th>{t.rating.value}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.eventId}>
              <td>{formatDate(p.at, lang)}</td>
              <td>{p.rating}</td>
            </tr>
          ))}
        </tbody>
      </Hidden>
    </>
  )
}

export function RatingTrend({ userId }: { userId: string }) {
  // Nothing at all without the flag: not even who is signed in is asked
  return useFeature('rankings') ? <RatingPanel userId={userId} /> : null
}

function RatingPanel({ userId }: { userId: string }) {
  const { user } = useAuth()
  const { t, message } = usePreferences()
  const id = useId()
  const [view, setView] = useState<RatingView | null>(null)
  const [error, setError] = useState('')
  const mine = user?.id === userId

  useEffect(() => {
    let live = true
    api
      .rating(userId)
      .then((r) => live && setView(r.rating))
      .catch((e) => live && setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)))
    return () => {
      live = false
    }
  }, [userId, message])

  const toggle = async (hidden: boolean) => {
    try {
      setView((await api.setRatingHidden(hidden)).rating)
    } catch (e) {
      setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e))
    }
  }

  return (
    <Wrap aria-labelledby={`${id}-title`}>
      <Title id={`${id}-title`}>{t.rating.title}</Title>
      {error && <Muted role="alert">{error}</Muted>}
      {view && view.hidden && !mine && <Muted>{t.rating.hiddenOther}</Muted>}
      {view && (!view.hidden || mine) && (
        <>
          {view.rating === null ? (
            <Muted>{t.rating.none}</Muted>
          ) : (
            <Headline>
              <strong data-testid="rating-value">{view.rating}</strong>
              {view.provisional && <Tag>{t.rating.provisional}</Tag>}
              <Muted as="span">{t.rating.events(view.events)}</Muted>
            </Headline>
          )}
          <TrendChart points={view.history} label={t.rating.chart} />
          {mine && (
            <div>
              <Toggle>
                <input type="checkbox" checked={view.hidden} onChange={(e) => void toggle(e.target.checked)} />
                {t.rating.hide}
              </Toggle>
              {view.hidden && <Muted>{t.rating.hiddenSelf}</Muted>}
            </div>
          )}
        </>
      )}
    </Wrap>
  )
}
