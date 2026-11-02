/**
 * Makes a VAPID key pair for Web Push (e1-t28, DEPLOY.md §4.17): `npm run vapid`. Prints the two
 * values to put in with `npx wrangler secret put VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Nothing
 * is written to disk; keep the private key only in the Worker's secrets.
 */
const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as { publicKey: CryptoKey; privateKey: CryptoKey }
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const publicKey = b64url(new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer))
const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d
console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${privateKey}`)
