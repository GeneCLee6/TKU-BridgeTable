import { useCallback, useEffect, useState } from 'react'
import styled from 'styled-components'
import { rankLabel, rankOf, suitOf } from '../../shared/cards.ts'
import type { AdminPuzzle } from '../../shared/puzzles.ts'
import { api, ApiError } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'
import { CardList } from './CardList.tsx'
import { SuitSymbol } from './Suit.tsx'
import { useToast } from './Toast.tsx'
import { Button, ErrorText, Muted } from './ui.tsx'

/**
 * The admin page's puzzles (`e10-t13`): every puzzle in full, so an officer can read the bridge in it,
 * and a button to publish it to this club's members or take it back. Every puzzle starts as a draft;
 * the server checks who may on every request (`ClubService.requireAdmin`).
 */

const Item = styled.article`
  display: grid;
  gap: ${({ theme }) => theme.space(1)};
  padding: ${({ theme }) => theme.space(3)} 0;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};

  & p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
`

const Heading = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
`

const Badge = styled.span<{ $published: boolean }>`
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme, $published }) => ($published ? theme.colors.successSoft : theme.colors.accentSoft)};
`

const Hands = styled.dl`
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 12px;
  margin: 0;

  & dd {
    margin: 0;
  }
`

export function AdminPuzzles() {
  const { t, lang, message } = usePreferences()
  const p = t.puzzles
  const toast = useToast()
  const [puzzles, setPuzzles] = useState<AdminPuzzle[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const failed = useCallback((e: unknown) => setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError), [message, t.genericError])
  useEffect(() => {
    api.admin.puzzles().then(({ puzzles }) => setPuzzles(puzzles), failed)
  }, [failed])

  const publish = async (id: string, published: boolean) => {
    setBusy(id)
    setError(null)
    try {
      setPuzzles((await api.admin.publishPuzzle(id, published)).puzzles)
      toast.success(p.adminDone)
    } catch (e) {
      failed(e)
    } finally {
      setBusy(null)
    }
  }

  if (!puzzles) return error ? <ErrorText role="alert">{error}</ErrorText> : <Muted role="status">{t.loading}</Muted>
  return (
    <div>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {lang !== 'zh' && <Muted>{p.zhOnly}</Muted>}
      {puzzles.map((puzzle) => {
        const published = puzzle.status === 'published'
        return (
          <Item key={puzzle.id} aria-label={puzzle.title}>
            <Heading>
              <strong>{puzzle.title}</strong>
              <Badge $published={published}>{published ? p.adminPublished(puzzle.publishedBy ?? '', formatDateTime(puzzle.publishedAt ?? 0, lang)) : p.adminDraft}</Badge>
            </Heading>
            <Muted>
              {p.level(puzzle.level)} · {puzzle.contract.level}
              <SuitSymbol suit={puzzle.contract.strain} /> {seatLetter.S} · {p.tally(puzzle.wonBefore, 0, puzzle.need)} · {p.adminStart(seatLetter[puzzle.leader])} · {p.adminDecisions(puzzle.size)}
            </Muted>
            <p>{puzzle.story}</p>
            <strong>{p.adminHands}</strong>
            <Hands>
              {(['N', 'E', 'S', 'W'] as const).map((seat) => (
                <div key={seat} style={{ display: 'contents' }}>
                  <dt>{seatLetter[seat]}</dt>
                  <dd>
                    <CardList cards={puzzle.hands[seat]} />
                  </dd>
                </div>
              ))}
            </Hands>
            <strong>{p.hintsTitle}</strong>
            {puzzle.hints.map((hint) => (
              <p key={hint}>{hint}</p>
            ))}
            <strong>{p.explanationTitle}</strong>
            <p>{puzzle.explanation}</p>
            <strong>{p.adminLine}</strong>
            <p>
              {puzzle.line.map((card, i) => (
                <span key={card}>
                  {i > 0 && i % 4 === 0 ? ' / ' : ' '}
                  <SuitSymbol suit={suitOf(card)} />
                  {rankLabel(rankOf(card))}
                </span>
              ))}
            </p>
            <div>
              <Button type="button" $variant={published ? undefined : 'primary'} disabled={busy !== null} onClick={() => void publish(puzzle.id, !published)}>
                {published ? p.adminUnpublish : p.adminPublish}
              </Button>
            </div>
          </Item>
        )
      })}
    </div>
  )
}
