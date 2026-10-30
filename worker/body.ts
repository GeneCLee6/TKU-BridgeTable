/**
 * Request bodies read with a size limit counted as the bytes arrive (e11-t32, docs/SECURITY.md
 * V5.1.4). `Content-Length` is only a hint: a body sent without it (chunked) or with a wrong one is
 * counted all the same, and reading stops at the first chunk over the limit, so an oversized
 * upload is never held in memory whole. No Cloudflare APIs: plain web streams, so Node tests run it.
 */

/** Refuses at once when the body says it is over `max`; otherwise nothing is read yet */
function checkDeclared(request: Request, max: number, tooLarge: () => Error) {
  const declared = Number(request.headers.get('Content-Length') ?? 0)
  if (declared > max) throw tooLarge()
}

/** The body's bytes, at most `max` of them; one byte more throws `tooLarge()` and stops the upload */
export async function readBytes(request: Request, max: number, tooLarge: () => Error): Promise<Uint8Array<ArrayBuffer>> {
  checkDeclared(request, max, tooLarge)
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

/** The body as text (UTF-8), at most `max` bytes */
export async function readText(request: Request, max: number, tooLarge: () => Error): Promise<string> {
  return new TextDecoder().decode(await readBytes(request, max, tooLarge))
}

/** The body as JSON, at most `max` bytes; what does not parse is `{}` (as the routes always took it) */
export async function readJson(request: Request, max: number, tooLarge: () => Error): Promise<unknown> {
  const text = await readText(request, max, tooLarge)
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** A multipart form, its body counted as it is parsed: over `max` bytes throws `tooLarge()` */
export async function readForm(request: Request, max: number, tooLarge: () => Error): Promise<FormData> {
  checkDeclared(request, max, tooLarge)
  if (!request.body) throw tooLarge()
  let total = 0
  let over = false
  const counted = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > max) {
          over = true
          controller.error(tooLarge())
        } else controller.enqueue(chunk)
      },
    }),
  )
  const headers = { 'Content-Type': request.headers.get('Content-Type') ?? '' }
  try {
    return await new Response(counted, { headers }).formData()
  } catch (error) {
    if (over) throw tooLarge()
    throw error
  }
}
