// TKU BridgeTable service worker: lets phones install the site as an app and open it quickly.
// Pages always come from the network when it is there (so a new version shows at once); built
// files, whose names change with every build, come from the cache. The API and the live
// connection are never touched.

const CACHE = 'tku-bridge-table-v1'
// The clubs this browser's push subscription is registered with (src/lib/push.ts writes it): kept
// across versions, read when the browser renews the subscription
const PUSH_CACHE = 'tku-bridge-table-push'
const PUSH_CLUBS = '/push-clubs'
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
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== PUSH_CACHE).map((key) => caches.delete(key))))
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
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/ws/')) return

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

// Push notifications (e1-t28, ARCHITECTURE.md §5.4): the server sends { title, body, url, tag },
// already in the member's language, encrypted for this browser (RFC 8291). Clicking one focuses a
// window of the site (one in the push's club first: `url` is under `/c/<id>/` for another club)
// and takes it to `url`, or opens one.
self.addEventListener('push', (event) => {
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    message = {}
  }
  const title = typeof message.title === 'string' && message.title ? message.title : '淡江牌桌'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === 'string' ? message.body : '',
      tag: typeof message.tag === 'string' ? message.tag : undefined,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: typeof message.url === 'string' ? message.url : '/' },
    }),
  )
})

/** Only this site's paths and https pages (TKU BridgeBook) are opened */
const pushTarget = (url) => {
  try {
    const target = new URL(url, self.location.origin)
    return target.protocol === 'https:' || target.origin === self.location.origin ? target : new URL('/', self.location.origin)
  } catch {
    return new URL('/', self.location.origin)
  }
}

/** The club a page of this site is for: `/c/<id>/…` is another club's, anything else 淡江's */
const clubOf = (url) => {
  const match = /^\/c\/([a-z][a-z0-9-]{1,23})(\/|$)/.exec(new URL(url).pathname)
  return match && match[1] !== 'tku' ? match[1] : 'tku'
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = pushTarget(event.notification.data && event.notification.data.url)
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      if (target.origin === self.location.origin) {
        // A window of the push's own club first (each club's pages are under its own address), else any of the site's
        const ours = windows.filter((w) => new URL(w.url).origin === self.location.origin)
        const open = ours.find((w) => clubOf(w.url) === clubOf(target.href)) || ours[0]
        if (open) {
          const focused = await open.focus()
          if (new URL(focused.url).href !== target.href) await focused.navigate(target.href).catch(() => undefined)
          return
        }
      }
      await self.clients.openWindow(target.href)
    }),
  )
})

/** The site's language closest to the browser's (the page sends its own when it subscribes) */
const siteLang = () => {
  const lang = (self.navigator.language || '').toLowerCase()
  if (lang.startsWith('zh')) return /cn|sg|hans/.test(lang) ? 'zh-Hans' : 'zh'
  return ['en', 'vi', 'ja', 'ko'].find((code) => lang.startsWith(code)) || 'zh'
}

/** The clubs this browser registered its subscription with; 淡江 alone for one made before clubs */
const pushClubs = () =>
  caches
    .open(PUSH_CACHE)
    .then((cache) => cache.match(PUSH_CLUBS))
    .then((hit) => (hit ? hit.json() : ['tku']))
    .then((clubs) => (Array.isArray(clubs) ? clubs.filter((id) => typeof id === 'string') : ['tku']))
    .catch(() => ['tku'])

// The browser renewed the subscription: hand the new one to every club it was registered with
// (each reads its own sign-in cookie; the old one answers 410 and is dropped)
self.addEventListener('pushsubscriptionchange', (event) => {
  const old = event.oldSubscription
  const key = old && old.options && old.options.applicationServerKey
  if (!key) return
  event.waitUntil(
    Promise.all([self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }), pushClubs()])
      .then(([subscription, clubs]) =>
        Promise.all(
          clubs.map((club) =>
            fetch('/api/push/subscribe', {
              method: 'POST',
              credentials: 'same-origin',
              headers: club === 'tku' ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json', 'X-Club-Id': club },
              body: JSON.stringify({ ...subscription.toJSON(), lang: siteLang() }),
            }).catch(() => undefined),
          ),
        ),
      )
      .catch(() => undefined),
  )
})
