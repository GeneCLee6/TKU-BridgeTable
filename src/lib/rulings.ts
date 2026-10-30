import type { BoardSummary } from '../../shared/protocol.ts'
import type { Strings } from '../strings.ts'
import { signed } from './format.ts'

/** A director's ruling in a few words (`e2-t35`): "Avg+ NS", "NS +420", "Avg" */
export function rulingLabel(t: Strings, ruling: NonNullable<BoardSummary['ruling']>): string {
  if (ruling.kind === 'score') return `NS ${signed(ruling.scoreNS ?? 0)}`
  return ruling.side ? `${t.director.kinds[ruling.kind]} ${ruling.side}` : t.director.kinds[ruling.kind]
}
