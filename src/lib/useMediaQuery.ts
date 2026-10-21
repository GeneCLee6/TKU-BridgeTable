import { useEffect, useState } from 'react'

/** Tracks a CSS media query. Falls back to false where matchMedia is unavailable. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    try {
      return window.matchMedia(query).matches
    } catch {
      return false
    }
  })

  useEffect(() => {
    let mql: MediaQueryList
    try {
      mql = window.matchMedia(query)
    } catch {
      return
    }
    const update = () => setMatches(mql.matches)
    update()
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [query])

  return matches
}
