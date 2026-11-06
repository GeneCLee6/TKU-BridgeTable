import { useT } from '../state/PreferencesContext.tsx'
import { Select } from './ui.tsx'

/**
 * An individual event's rounds to play (`e9-t15`, ARCHITECTURE.md §5.25): all of the movement's
 * n − 1 (no value), or only the first 1 … `max`. On the pairs-event form and the tournament form
 */
export function IndividualRoundsSelect({
  value,
  max,
  onChange,
}: {
  value: number | undefined
  max: number
  onChange: (rounds: number | undefined) => void
}) {
  const t = useT()
  return (
    <label>
      {t.pairs.rounds}
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">{t.pairs.roundsAll}</option>
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
    </label>
  )
}
