/// <reference types="vite/client" />

/** A public system's card, worked out when the site is built (scripts/system-cards-plugin.ts) */
declare module 'virtual:system-card-*' {
  const card: import('../shared/robot/system/card.ts').SystemCard
  export default card
}

/** Tests only: the browser's build refuses this module (scripts/system-cards-plugin.ts) */
declare module 'virtual:system-card-tku' {
  const card: string
  export default card
}
