import { SEATS } from '../../shared/cards.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * The seats where a robot sat in for a member who dropped offline during the board (代打, e2-t31),
 * as a term and description inside the record's details list; nothing when there were none
 */
export function RecordSubstitutes({ record }: { record: BoardRecord }) {
  const { t } = usePreferences()
  const seats = SEATS.filter((seat) => record.substitutes?.[seat])
  if (!seats.length) return null
  return (
    <>
      <dt>{t.substitutes}</dt>
      <dd>
        {seats.map((seat) => (
          <div key={seat}>
            {t.seatNames[seat]} · {t.substituteFor(record.substitutes![seat]!.username)}
          </div>
        ))}
      </dd>
    </>
  )
}
