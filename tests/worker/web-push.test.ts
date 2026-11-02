// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  allowedEndpoint,
  base64url,
  encryptPush,
  fromBase64url,
  pushFrom,
  RECORD_SIZE,
  validKeys,
  VAPID_JWT_MS,
  WebPush,
} from '../../worker/web-push.ts'

const encoder = new TextEncoder()

/** RFC 8291 Appendix A (the example of §5), whitespace removed */
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}

/** A browser's side: a P-256 key pair and an auth secret, as `PushSubscription.toJSON().keys` */
async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const p256dh = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  const auth = base64url(crypto.getRandomValues(new Uint8Array(16)))
  return { p256dh, auth, privateKey: pair.privateKey }
}

const hkdf = async (salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number) => {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}

/** What the browser does with an `aes128gcm` push (RFC 8291 §3.4, RFC 8188), written apart from the sender */
async function decrypt(body: Uint8Array, browser: { p256dh: string; auth: string; privateKey: CryptoKey }): Promise<string> {
  const salt = body.slice(0, 16)
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16)
  const idlen = body[20]
  const asPublic = body.slice(21, 21 + idlen)
  const record = body.slice(21 + idlen)
  expect(rs).toBe(RECORD_SIZE)
  const senderKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey }, browser.privateKey, 256))
  const uaPublic = fromBase64url(browser.p256dh)
  const info = new Uint8Array([...encoder.encode('WebPush: info\0'), ...uaPublic, ...asPublic])
  const ikm = await hkdf(fromBase64url(browser.auth), ecdh, info, 32)
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, record))
  // The last record ends with 0x02 then zero padding
  let end = padded.length - 1
  while (padded[end] === 0) end--
  expect(padded[end]).toBe(2)
  return new TextDecoder().decode(padded.slice(0, end))
}

async function vapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d!
  return { publicKey, privateKey, subject: 'mailto:club@example.org', verifyKey: pair.publicKey }
}

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc:def'

describe('Web Push encryption (RFC 8291)', () => {
  it("matches the RFC's published example", async () => {
    const body = await encryptPush(
      fromBase64url(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { publicKey: fromBase64url(RFC.asPublic), privateKey: fromBase64url(RFC.asPrivate), salt: fromBase64url(RFC.salt) },
    )
    expect(body.length).toBe(86 + fromBase64url(RFC.ciphertext).length)
    expect(base64url(body.slice(0, 86))).toBe(RFC.header)
    expect(base64url(body.slice(86))).toBe(RFC.ciphertext)
  })

  it('the RFC example reads back with the browser key', async () => {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: base64url(fromBase64url(RFC.uaPublic).slice(1, 33)),
        y: base64url(fromBase64url(RFC.uaPublic).slice(33)),
        d: RFC.uaPrivate,
      },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    )
    const body = new Uint8Array([...fromBase64url(RFC.header), ...fromBase64url(RFC.ciphertext)])
    expect(await decrypt(body, { p256dh: RFC.uaPublic, auth: RFC.auth, privateKey })).toBe('When I grow up, I want to be a watermelon')
  })

  it('uses a new key and salt for every message, and the browser reads each', async () => {
    const browser = await browserKeys()
    const text = JSON.stringify({ title: '淡江牌桌', body: 'amy 邀請你參加挑戰', url: '/challenges/x', tag: 'n1' })
    const one = await encryptPush(encoder.encode(text), browser)
    const two = await encryptPush(encoder.encode(text), browser)
    expect(base64url(one.slice(0, 86))).not.toBe(base64url(two.slice(0, 86)))
    expect(await decrypt(one, browser)).toBe(text)
    expect(await decrypt(two, browser)).toBe(text)
  })

  it('refuses a message that does not fit in one record', async () => {
    const browser = await browserKeys()
    await expect(encryptPush(new Uint8Array(RECORD_SIZE), browser)).rejects.toThrow()
  })

  it('checks the sizes of the browser keys', async () => {
    const browser = await browserKeys()
    expect(validKeys(browser.p256dh, browser.auth)).toBe(true)
    expect(validKeys(browser.p256dh.slice(4), browser.auth)).toBe(false)
    expect(validKeys(browser.p256dh, base64url(new Uint8Array(8)))).toBe(false)
    expect(validKeys('***', browser.auth)).toBe(false)
  })
})

describe('VAPID (RFC 8292)', () => {
  it('signs an ES256 JWT for the push service origin, kept until near expiry', async () => {
    const keys = await vapidKeys()
    let time = 1_700_000_000_000
    const push = new WebPush(keys, fetch, () => time)
    const jwt = await push.jwtFor('https://fcm.googleapis.com')
    const [header, claims, signature] = jwt.split('.')
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(header)))).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(claims)))).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Math.floor((time + VAPID_JWT_MS) / 1000),
      sub: 'mailto:club@example.org',
    })
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.verifyKey,
      fromBase64url(signature),
      encoder.encode(`${header}.${claims}`),
    )
    expect(ok).toBe(true)
    // The same origin gets the same JWT for most of its life; another origin its own
    time += VAPID_JWT_MS / 2
    expect(await push.jwtFor('https://fcm.googleapis.com')).toBe(jwt)
    expect(await push.jwtFor('https://updates.push.services.mozilla.com')).not.toBe(jwt)
    time += VAPID_JWT_MS / 2
    expect(await push.jwtFor('https://fcm.googleapis.com')).not.toBe(jwt)
  })

  it('posts the encrypted message with the VAPID headers', async () => {
    const keys = await vapidKeys()
    const browser = await browserKeys()
    const posted: { url: string; init: RequestInit }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      posted.push({ url, init })
      return new Response('', { status: 201 })
    }) as unknown as typeof fetch
    const push = new WebPush(keys, fetcher)
    const result = await push.send({ endpoint: ENDPOINT, ...browser }, '{"title":"x"}', { urgency: 'high', ttl: 3600 })
    expect(result.status).toBe(201)
    expect(posted).toHaveLength(1)
    expect(posted[0].url).toBe(ENDPOINT)
    const headers = posted[0].init.headers as Record<string, string>
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers.TTL).toBe('3600')
    expect(headers.Urgency).toBe('high')
    expect(headers.Authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`))
    expect(await decrypt(posted[0].init.body as Uint8Array, browser)).toBe('{"title":"x"}')
  })

  it('is off unless all three settings are set and well formed', async () => {
    const keys = await vapidKeys()
    const env = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: keys.subject }
    expect(pushFrom(env)?.publicKey).toBe(keys.publicKey)
    expect(pushFrom({})).toBeUndefined()
    expect(pushFrom({ ...env, VAPID_SUBJECT: '' })).toBeUndefined()
    expect(pushFrom({ ...env, VAPID_SUBJECT: 'club@example.org' })).toBeUndefined()
    expect(pushFrom({ ...env, VAPID_PRIVATE_KEY: keys.publicKey })).toBeUndefined()
  })
})

describe('push endpoints', () => {
  it('only posts to the push services browsers use', () => {
    expect(allowedEndpoint(ENDPOINT)).toBe(true)
    expect(allowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true)
    expect(allowedEndpoint('https://web.push.apple.com/QGx')).toBe(true)
    expect(allowedEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true)
    expect(allowedEndpoint('http://fcm.googleapis.com/fcm/send/x')).toBe(false)
    expect(allowedEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false)
    expect(allowedEndpoint('https://evil.example/push.apple.com')).toBe(false)
    expect(allowedEndpoint('https://user:pw@fcm.googleapis.com/x')).toBe(false)
    expect(allowedEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false)
    expect(allowedEndpoint(`${ENDPOINT}${'x'.repeat(1100)}`)).toBe(false)
    expect(allowedEndpoint('not a url')).toBe(false)
  })
})
