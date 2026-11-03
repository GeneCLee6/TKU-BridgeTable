import { useId } from 'react'
import styled from 'styled-components'
import { FORUM_LIMITS } from '../../shared/forum.ts'
import type { ReleaseChoice } from '../lib/forumRelease.ts'
import { FieldHint, Input } from './ui.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * When a post comes out (E13 e13-t12, ARCHITECTURE.md §5.19): the post editor's 「排程發布」 for the
 * officers. The server decides who may schedule and when (`forumScheduleOfficersOnly`, `forumScheduleTime`); this only offers it. The
 * values and the time conversions are in `lib/forumRelease.ts`.
 */

const Box = styled.fieldset`
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
  margin: 0;
  padding: ${({ theme }) => theme.space(3)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};

  & > label {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${({ theme }) => theme.space(2)};
  }
`

/** 排程發布: a box to tick and the time; only for the officers, only while the post is not out */
export function ReleaseFields({
  value,
  onChange,
}: {
  value: ReleaseChoice
  onChange: (value: ReleaseChoice) => void
}) {
  const { t } = usePreferences()
  const n = t.forumNews
  const timeId = useId()
  const hintId = useId()
  return (
    <Box>
      <label>
        <input
          type="checkbox"
          checked={value.schedule}
          onChange={(e) => onChange({ ...value, schedule: e.target.checked })}
        />
        <span>{n.schedule}</span>
      </label>
      {value.schedule && (
        <label htmlFor={timeId}>
          <span>{n.scheduleTime}</span>
          <Input
            id={timeId}
            type="datetime-local"
            $size="sm"
            aria-describedby={hintId}
            value={value.at}
            required
            onChange={(e) => onChange({ ...value, at: e.target.value })}
          />
        </label>
      )}
      <FieldHint id={hintId}>{n.scheduleHint(FORUM_LIMITS.scheduleDaysMax)}</FieldHint>
    </Box>
  )
}
