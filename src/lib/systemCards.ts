import { useEffect, useState } from 'react'
import { DEFAULT_CLUB_ID } from '../../shared/clubs.ts'
import { isOpenRobotKind, TKU_CARD_API, type OpenRobotKind, type RobotKind } from '../../shared/protocol.ts'
import type { SystemCard } from '../../shared/robot/system/card.ts'
import { request } from './api.ts'
import { appPath, currentClub } from './club.ts'

/**
 * The system cards in the browser (e5-t52). A public system's card is public rules: a chunk made when
 * the site is built, loaded the first time someone opens it. The club's card is for members of 淡江 only
 * (ARCHITECTURE.md §4), never in an asset: it comes from the server, is not kept, and is not offered
 * to anyone the server would refuse. Only types come from the engine here.
 */

/** The address of a card's page, for links that open in a new tab (a table's page must stay open) */
export const systemCardUrl = (system: RobotKind) => appPath(`/system-card/${system}`)

/** Whether the server would give this viewer the card (`worker/system-card.ts`) */
export const mayReadCard = (system: RobotKind, user: unknown) => isOpenRobotKind(system) || (!!user && currentClub() === DEFAULT_CLUB_ID)

/** Each public system's chunk; a bundler only splits an import it can read, so one line per system */
const OPEN_CARDS: Record<OpenRobotKind, () => Promise<{ default: SystemCard }>> = {
  gib: () => import('virtual:system-card-gib'),
  sayc: () => import('virtual:system-card-sayc'),
  precision: () => import('virtual:system-card-precision'),
}

const load = (system: RobotKind): Promise<SystemCard> =>
  isOpenRobotKind(system) ? OPEN_CARDS[system]().then((module) => module.default) : request<SystemCard>(TKU_CARD_API)

export function useSystemCard(system: RobotKind): { card: SystemCard | null; failed: boolean } {
  const [state, setState] = useState<{ system: RobotKind; card: SystemCard | null; failed: boolean } | null>(null)
  useEffect(() => {
    let live = true
    load(system).then(
      (card) => live && setState({ system, card, failed: false }),
      () => live && setState({ system, card: null, failed: true }),
    )
    return () => {
      live = false
    }
  }, [system])
  // A card still on its way must not show under the other system's name
  return state?.system === system ? state : { card: null, failed: false }
}
