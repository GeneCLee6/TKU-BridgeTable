/**
 * The member's own sessions (e11-t23) and data (e11-t27): what "My account" lists and downloads.
 * Pure functions only.
 */

/** A signed-in device as "My account" lists it; never the session's token */
export interface SessionInfo {
  id: string
  /** Browser and system, from the User-Agent at sign-in (`deviceLabel`); '' when unknown */
  device: string
  createdAt: number
  /** The last request seen with it, to the hour (`SESSION_SEEN_STEP_MS`) */
  lastSeenAt: number
  /** The session this request came with */
  current: boolean
}

/** How often a session's last-seen time is written: at most once an hour, not on every request */
export const SESSION_SEEN_STEP_MS = 60 * 60_000

/** Most characters of a device label kept */
export const DEVICE_LABEL_MAX = 60

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bLine\//, 'LINE'],
  [/\bFBA[NV]\b|\bFB_IAB\b/, 'Facebook'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*Safari\//, 'Safari'],
]

const SYSTEMS: [RegExp, string][] = [
  [/\biPad\b/, 'iPad'],
  [/\biPhone\b/, 'iPhone'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b/, 'Linux'],
]

/** "Chrome · Windows" from a User-Agent, so a member can tell their devices apart; '' when unknown */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = String(userAgent ?? '')
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1]
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1]
  return [browser, system].filter(Boolean).join(' · ').slice(0, DEVICE_LABEL_MAX)
}

/** The format of "My account"'s download, so a later version can be told apart */
export const ACCOUNT_EXPORT_VERSION = 1
