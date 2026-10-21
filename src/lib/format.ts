/** Display formatting that is not a component */

export function formatDateTime(at: number): string {
  return new Date(at).toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** +620, -100, 0 */
export const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`)
