import { Star } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { FEATURED_CATEGORIES, FEATURED_LIMITS, type FeaturedBoard, type FeaturedCategory } from '../../shared/featured.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { api } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button, Card, ErrorText, Field, FieldHint, FieldLabel, Input, Select, Textarea } from './ui.tsx'

/**
 * A board's feature on its record page (精選牌局, AC-4.5): the title, category, who featured it and
 * the explanation, and the note for the trick the replay is on (`e4-t31`). Members with the
 * `boardCurate` permission feature the board here, edit the feature and take it off (`e4-t29`).
 * Only a board everyone may see can be featured (ARCHITECTURE.md §4); the server checks again.
 */

const Head = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;

  & > h2 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 18px; }
`

const Badge = styled.span`
  padding: 2px 8px;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.primarySoft};
  color: ${({ theme }) => theme.colors.primary};
  font-size: 13px;
  font-weight: 700;
`

const Byline = styled.p`
  margin: 4px 0 8px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
`

const Prose = styled.p`
  margin: 0 0 8px;
  white-space: pre-wrap;
  line-height: 1.6;
`

const TrickNote = styled.div`
  margin-top: 8px;
  padding: 8px 12px;
  border-left: 3px solid ${({ theme }) => theme.colors.primary};
  background: ${({ theme }) => theme.colors.primarySoft};

  & > strong { display: block; margin-bottom: 4px; }
  & > p { margin: 0; white-space: pre-wrap; }
`

const Form = styled.form`
  display: grid;
  gap: 12px;
  margin-top: 12px;
`

const NoteSet = styled.fieldset`
  display: grid;
  gap: 6px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
`

const Notes = styled.div`
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

interface Draft {
  title: string
  category: FeaturedCategory
  explanation: string
  trickNotes: Record<number, string>
}

const draftOf = (f: FeaturedBoard | null): Draft => ({
  title: f?.title ?? '',
  category: f?.category ?? 'declarer',
  explanation: f?.explanation ?? '',
  trickNotes: { ...f?.trickNotes },
})

export function FeaturedPanel({ record, trick, onTrick }: { record: BoardRecord; trick: number; onTrick?: (trick: number) => void }) {
  const { t, lang, message } = usePreferences()
  const { user } = useAuth()
  const [loaded, setLoaded] = useState<{ id: string; featured: FeaturedBoard | null } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [openedAt] = useState(() => Date.now())

  useEffect(() => {
    let live = true
    api
      .featuredBoard(record.id)
      .then((r) => live && setLoaded({ id: record.id, featured: r.featured }))
      .catch(() => live && setLoaded({ id: record.id, featured: null }))
    return () => {
      live = false
    }
  }, [record.id])

  const featured = loaded?.id === record.id ? loaded.featured : null
  const curator = !!user?.permissions.includes('boardCurate')
  const revealed = record.revealAt === undefined || record.revealAt <= openedAt
  const tricks = Math.ceil(record.board.play.length / 4)
  if (!featured && !(curator && revealed && loaded)) return null

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft) return
    setBusy(true)
    setError('')
    try {
      const { featured: saved } = await api.saveFeatured(record.id, draft)
      setLoaded({ id: record.id, featured: saved })
      setDraft(null)
    } catch (err) {
      const e = err as { code?: string; params?: Record<string, string | number>; message: string }
      setError(message(e.code ?? '', e.params, e.message))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(t.confirmUnfeature)) return
    setBusy(true)
    setError('')
    try {
      await api.unfeature(record.id)
      setLoaded({ id: record.id, featured: null })
      setDraft(null)
    } catch (err) {
      const e = err as { code?: string; params?: Record<string, string | number>; message: string }
      setError(message(e.code ?? '', e.params, e.message))
    } finally {
      setBusy(false)
    }
  }

  const note = featured && trick > 0 ? featured.trickNotes[trick] : undefined
  return (
    <Card aria-label={featured ? featured.title : t.featureBoard}>
      <Head>
        {featured ? (
          <h2>
            <Star size={18} aria-hidden />
            <Badge>{t.featuredBadge}</Badge>
            {featured.title}
          </h2>
        ) : (
          <span />
        )}
        {curator && !draft && (
          <Actions>
            <Button type="button" $size="sm" onClick={() => setDraft(draftOf(featured))}>
              {featured ? t.editFeatured : t.featureBoard}
            </Button>
            {featured && (
              <Button type="button" $size="sm" $variant="ghost" onClick={remove} $busy={busy}>
                {t.unfeature}
              </Button>
            )}
          </Actions>
        )}
      </Head>
      {featured && (
        <>
          <Byline>
            {t.featuredCategories[featured.category]} · {t.featuredBy(featured.by.username, formatDateTime(featured.at, lang))}
          </Byline>
          {featured.explanation && <Prose>{featured.explanation}</Prose>}
          <div aria-live="polite">
            {note && (
              <TrickNote>
                <strong>{t.trickNoteLabel(trick)}</strong>
                <p>{note}</p>
              </TrickNote>
            )}
          </div>
          {onTrick && Object.keys(featured.trickNotes).length > 0 && (
            <Actions role="group" aria-label={t.trickNotes}>
              {Object.keys(featured.trickNotes).map((n) => (
                <Button key={n} type="button" $size="sm" $variant="ghost" onClick={() => onTrick(Number(n))}>
                  {t.trickNoteLabel(Number(n))}
                </Button>
              ))}
            </Actions>
          )}
        </>
      )}
      {draft && (
        <Form onSubmit={save}>
          <Field>
            <FieldLabel htmlFor="featured-title">{t.featuredTitleLabel}</FieldLabel>
            <Input
              id="featured-title"
              value={draft.title}
              maxLength={FEATURED_LIMITS.titleMax}
              required
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="featured-category">{t.featuredCategoryLabel}</FieldLabel>
            <Select
              id="featured-category"
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value as FeaturedCategory })}
            >
              {FEATURED_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t.featuredCategories[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="featured-explanation">{t.featuredExplanation}</FieldLabel>
            <Textarea
              id="featured-explanation"
              rows={5}
              value={draft.explanation}
              maxLength={FEATURED_LIMITS.explanationMax}
              onChange={(e) => setDraft({ ...draft, explanation: e.target.value })}
            />
          </Field>
          {tricks > 0 && (
            <NoteSet>
              <FieldLabel as="legend">{t.trickNotes}</FieldLabel>
              <FieldHint>{t.trickNoteHint}</FieldHint>
              <Notes>
                {Array.from({ length: tricks }, (_, i) => i + 1).map((n) => (
                  <Field key={n}>
                    <FieldLabel htmlFor={`trick-note-${n}`}>{t.trickNoteLabel(n)}</FieldLabel>
                    <Textarea
                      id={`trick-note-${n}`}
                      rows={2}
                      value={draft.trickNotes[n] ?? ''}
                      maxLength={FEATURED_LIMITS.trickNoteMax}
                      onChange={(e) => setDraft({ ...draft, trickNotes: { ...draft.trickNotes, [n]: e.target.value } })}
                    />
                  </Field>
                ))}
              </Notes>
            </NoteSet>
          )}
          <Actions>
            <Button type="submit" $variant="primary" $busy={busy}>
              {t.save}
            </Button>
            <Button type="button" $variant="ghost" onClick={() => setDraft(null)}>
              {t.cancel}
            </Button>
          </Actions>
        </Form>
      )}
      {error && <ErrorText role="alert">{error}</ErrorText>}
    </Card>
  )
}
