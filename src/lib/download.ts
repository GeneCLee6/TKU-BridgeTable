import { ApiError } from './api.ts'
import { clubHeaders } from './club.ts'

/**
 * Files the member downloads (PBN, LIN; e4-t36, e4-t37): made in the page or fetched from the API,
 * then saved through a `blob:` address (the page's CSP allows it, docs/SECURITY.md §2). Fetching
 * first, rather than following a link, lets an error show on the page in the member's language
 */

/** Saves text as a file named `name` */
export function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** The file name the server gave (`Content-Disposition`), or `fallback` */
function fileName(response: Response, fallback: string) {
  return /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? fallback
}

/**
 * Downloads a file from the API and saves it; an error answer throws ApiError as `request` does.
 * Resolves to the response's headers (the PBN export says how many boards the search found)
 */
export async function downloadFile(path: string, fallback: string): Promise<Headers> {
  const response = await fetch(path, { credentials: 'same-origin', headers: clubHeaders() })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new ApiError(data.error ?? `HTTP ${response.status}`, response.status, data.code ?? '', data.params ?? {})
  }
  saveText(fileName(response, fallback), await response.text())
  return response.headers
}
