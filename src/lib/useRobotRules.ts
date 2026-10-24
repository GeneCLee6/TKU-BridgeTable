import { useEffect, useState } from 'react'

type RobotRules = typeof import('./robotRules.ts')

let loading: Promise<RobotRules> | null = null

/** Loads the robots' rules once, the first time a table needs them */
export const loadRobotRules = () => (loading ??= import('./robotRules.ts'))

/** The robots' rules when `needed`, once loaded (null until then) */
export function useRobotRules(needed: boolean): RobotRules | null {
  const [rules, setRules] = useState<RobotRules | null>(null)
  useEffect(() => {
    if (!needed || rules) return
    let live = true
    void loadRobotRules().then((loaded) => live && setRules(loaded))
    return () => {
      live = false
    }
  }, [needed, rules])
  return rules
}
