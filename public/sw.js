// TKU BridgeTable service worker: lets phones install the site as an app and open it quickly.
// Pages always come from the network when it is there (so a new version shows at once); built
// files, whose names change with every build, come from the cache. The API and the live
// connection are never touched.

const CACHE = 'tku-bridge-table-v1'
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

const keep = (request, response) => {
  if (response.ok) {
    const copy = response.clone()
    void caches.open(CACHE).then((cache) => cache.put(request, copy))
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return

  if (request.mode === 'navigate') {
    // Every page is the same app shell: newest from the network, the cached one when offline
    event.respondWith(
      fetch(request)
        .then((response) => keep('/', response))
        .catch(() => caches.match('/')),
    )
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((response) => keep(request, response))))
  }
})
