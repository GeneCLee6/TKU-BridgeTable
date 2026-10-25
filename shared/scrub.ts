/**
 * Masks what could identify someone in an error report: query strings and fragments of URLs
 * (tokens, ids), e-mail addresses and long digit runs. The browser scrubs before sending and the
 * server again before logging, so it never trusts the browser
 */
export function scrub(text: string, max: number): string {
  return text
    .replace(/(https?:\/\/[^\s?#)]*)[?#][^\s)]*/g, '$1')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\d{6,}/g, '<n>')
    .slice(0, max)
}
