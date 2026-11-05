import { useEffect, useState } from 'react'
import type { RobotKind } from '../../shared/protocol.ts'
import type { SystemCard, SystemCards } from '../../shared/robot/system/card.ts'
import { appPath } from './club.ts'

/**
 * The system cards in the browser (e5-t52): data worked out when the site is built
 * (`scripts/system-cards-plugin.ts`), loaded once, the first time someone opens a card. Only types
 * come from the engine here, so opening a card asks the server nothing and sends nothing to it.
 */

/** The address of a card's page, for links that open in a new tab (a table's page must stay open) */
export const systemCardUrl = (system: RobotKind) => appPath(`/system-card/${system}`)

let loading: Promise<SystemCards> | null = null

function loadSystemCards(): Promise<SystemCards> {
  loading ??= import('virtual:system-cards').then((module) => module.default)
  return loading
}

export function useSystemCard(system: RobotKind): SystemCard | null {
  const [cards, setCards] = useState<SystemCards | null>(null)
  useEffect(() => {
    let live = true
    void loadSystemCards().then((loaded) => live && setCards(loaded))
    return () => {
      live = false
    }
  }, [])
  return cards?.[system] ?? null
}
