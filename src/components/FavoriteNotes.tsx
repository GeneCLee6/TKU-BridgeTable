import { Pencil, X } from 'lucide-react'
import { useId, useState, type KeyboardEvent } from 'react'
import styled from 'styled-components'
import { cleanTags, tagSuggestions } from '../../shared/favorites.ts'
import { LIMITS, type Favorite, type FavoriteTag } from '../../shared/protocol.ts'
import { api } from '../lib/api.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button, ErrorText, Field, FieldLabel, Input, Textarea } from './ui.tsx'

/**
 * A favorite's private note and tags (e4-t27, AC-4.4), edited in place on 「我的收藏」. Tags are
 * typed and added with Enter or a comma; the member's own tags that match what is typed are
 * offered to pick (autocomplete). The same cleaning rules as the server (`shared/favorites.ts`).
 */

const Tags = styled.ul`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
`

const Tag = styled.li`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 10px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.accentSoft};
  color: ${({ theme }) => theme.colors.text};
  font-size: 13px;

  & > button {
    display: inline-flex;
    padding: 0;
    border: 0;
    background: transparent;
    color: ${({ theme }) => theme.colors.textMuted};
    cursor: pointer;
  }
`

const Note = styled.p<{ $empty: boolean }>`
  margin: 0;
  color: ${({ theme, $empty }) => ($empty ? theme.colors.textMuted : theme.colors.text)};
  font-size: 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`

const View = styled.div`
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: start;
  gap: 6px 10px;
`

const Editor = styled.div`
  display: grid;
  gap: 10px;
`

const Suggestions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`

const Suggestion = styled.button`
  padding: 2px 10px;
  border: 1px dashed ${({ theme }) => theme.colors.borderStrong};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-size: 13px;
`

const Actions = styled.div`
  display: flex;
  gap: 8px;
  justify-content: flex-end;
`

const IconButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
`

interface Props {
  favorite: Favorite
  /** The member's tags, for autocomplete */
  known: FavoriteTag[]
  onSaved: (favorite: Favorite) => void
}

export function FavoriteNotes({ favorite, known, onSaved }: Props) {
  const { t, message } = usePreferences()
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(favorite.note)
  const [tags, setTags] = useState(favorite.tags)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const id = useId()

  const open = () => {
    setNote(favorite.note)
    setTags(favorite.tags)
    setTyped('')
    setError('')
    setEditing(true)
  }

  const addTag = (raw: string) => {
    const next = cleanTags([...tags, raw])
    if (next.length <= LIMITS.favoriteTagsMax) setTags(next)
    setTyped('')
  }

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      if (typed.trim()) addTag(typed)
    } else if (event.key === 'Backspace' && !typed && tags.length > 0) setTags(tags.slice(0, -1))
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      // Whatever is still in the tag box counts too
      const { favorite: saved } = await api.saveFavorite(favorite.boardId, { note, tags: cleanTags([...tags, typed]) })
      onSaved(saved)
      setEditing(false)
    } catch (e) {
      const err = e as { code?: string; params?: Record<string, string | number>; message: string }
      setError(message(err.code ?? '', err.params, err.message))
    } finally {
      setBusy(false)
    }
  }

  if (!editing)
    return (
      <View>
        <div>
          {favorite.tags.length > 0 && (
            <Tags aria-label={t.favoriteTags}>
              {favorite.tags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </Tags>
          )}
          <Note $empty={!favorite.note}>{favorite.note || t.favoriteNoNote}</Note>
        </div>
        <IconButton type="button" onClick={open} aria-label={t.favoriteEdit} title={t.favoriteEdit}>
          <Pencil size={16} aria-hidden />
        </IconButton>
      </View>
    )

  const suggestions = tagSuggestions(known, tags, typed)
  return (
    <Editor>
      <Field>
        <FieldLabel htmlFor={`${id}-note`}>{t.favoriteNote}</FieldLabel>
        <Textarea
          id={`${id}-note`}
          value={note}
          maxLength={LIMITS.favoriteNoteMax}
          placeholder={t.favoriteNotePlaceholder}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-tags`}>{t.favoriteTags}</FieldLabel>
        {tags.length > 0 && (
          <Tags>
            {tags.map((tag) => (
              <Tag key={tag}>
                {tag}
                <button type="button" aria-label={t.favoriteTagRemove(tag)} onClick={() => setTags(tags.filter((x) => x !== tag))}>
                  <X size={14} aria-hidden />
                </button>
              </Tag>
            ))}
          </Tags>
        )}
        <Input
          id={`${id}-tags`}
          value={typed}
          maxLength={LIMITS.favoriteTagMax}
          placeholder={t.favoriteTagPlaceholder}
          disabled={tags.length >= LIMITS.favoriteTagsMax}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={onKey}
        />
        {suggestions.length > 0 && (
          <Suggestions>
            {suggestions.map((tag) => (
              <Suggestion key={tag} type="button" onClick={() => addTag(tag)}>
                {tag}
              </Suggestion>
            ))}
          </Suggestions>
        )}
      </Field>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <Actions>
        <Button type="button" $small onClick={() => setEditing(false)}>
          {t.cancel}
        </Button>
        <Button type="button" $small $variant="primary" $busy={busy} onClick={save}>
          {t.save}
        </Button>
      </Actions>
    </Editor>
  )
}
