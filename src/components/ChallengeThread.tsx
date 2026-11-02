import { Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { CHALLENGE_COMMENT_MAX, type ChallengeCommentsView } from '../../shared/challenge-comments.ts'
import { playerName } from '../strings.ts'
import { ApiError, api } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button, Card, ErrorText, Muted, Textarea } from './ui.tsx'

/**
 * One board's discussion thread of a challenge (`e7-t27`). The server decides everything
 * (`challengeThreadAccess`, §4): someone still playing gets no thread at all, so this shows nothing
 * to them; those who did not play every board read without a box to write in.
 */

const Section = styled(Card)`
  margin: 16px 0;

  & > h2 {
    margin: 0 0 6px;
    font-size: 18px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const List = styled.ol`
  list-style: none;
  margin: 12px 0;
  padding: 0;
  display: grid;
  gap: 10px;
`

const Item = styled.li`
  padding: 8px 10px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};

  & > header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
  }
  & > header > small {
    color: ${({ theme }) => theme.colors.textMuted};
  }
  & > p {
    margin: 4px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
`

const Remove = styled.button`
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  border: 0;
  background: none;
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;
  &:hover {
    color: ${({ theme }) => theme.colors.danger};
  }
`

const Form = styled.form`
  display: grid;
  gap: 8px;
  justify-items: end;

  & > textarea {
    width: 100%;
  }
`

export function ChallengeThread({ challengeId, seq }: { challengeId: string; seq: number }) {
  const { t, lang, message } = usePreferences()
  // What was loaded for which board: a new board shows nothing until its own thread arrives
  const key = `${challengeId}/${seq}`
  const [loaded, setLoaded] = useState<{ key: string; thread?: ChallengeCommentsView; hidden?: boolean } | null>(null)
  const current = loaded?.key === key ? loaded : null
  const thread = current?.thread ?? null
  const hidden = !!current?.hidden
  const setThread = (next: ChallengeCommentsView) => setLoaded({ key, thread: next })
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const s = t.challengeExtras
  const errorText = (e: unknown) => (e instanceof ApiError ? message(e.code, e.params, e.message) : String(e))

  useEffect(() => {
    let live = true
    const asked = `${challengeId}/${seq}`
    api
      .challengeThread(challengeId, seq)
      .then((r) => live && setLoaded({ key: asked, thread: r.thread }))
      .catch((e) => {
        if (!live) return
        // Not shown to this member (yet): no thread, no hint of one
        if (e instanceof ApiError && e.status === 404) setLoaded({ key: asked, hidden: true })
        else setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e))
      })
    return () => {
      live = false
    }
  }, [challengeId, seq, message])

  if (hidden) return null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      setThread((await api.postChallengeComment(challengeId, seq, text)).thread)
      setText('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: number) => {
    setError('')
    try {
      setThread((await api.removeChallengeComment(challengeId, seq, id)).thread)
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <Section aria-labelledby="thread-title">
      <h2 id="thread-title">{s.threadTitle}</h2>
      <Muted>{s.threadNote}</Muted>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {!thread ? (
        !error && <Muted>{t.loading}</Muted>
      ) : (
        <>
          {thread.comments.length === 0 ? (
            <Muted>{s.threadEmpty}</Muted>
          ) : (
            <List aria-label={s.threadTitle}>
              {thread.comments.map((c) => (
                <Item key={c.id}>
                  <header>
                    <strong>{c.user ? playerName(t, c.user) : t.deletedMember}</strong>
                    <small>{formatDateTime(c.at, lang)}</small>
                    {c.removable && (
                      <Remove type="button" aria-label={s.threadRemove} title={s.threadRemove} onClick={() => remove(c.id)}>
                        <Trash2 size={16} aria-hidden />
                      </Remove>
                    )}
                  </header>
                  <p>{c.text}</p>
                </Item>
              ))}
            </List>
          )}
          {thread.canPost ? (
            <Form onSubmit={submit}>
              <Textarea
                aria-label={s.threadPlaceholder}
                placeholder={s.threadPlaceholder}
                maxLength={CHALLENGE_COMMENT_MAX}
                rows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <Button type="submit" $variant="primary" disabled={busy || !text.trim()}>
                {s.threadPost}
              </Button>
            </Form>
          ) : (
            <Muted>{s.threadReadOnly}</Muted>
          )}
        </>
      )}
    </Section>
  )
}
