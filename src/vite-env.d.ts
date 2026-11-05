/// <reference types="vite/client" />

/** The 2/1 system card, worked out when the site is built (scripts/system-cards-plugin.ts) */
declare module 'virtual:system-card-gib' {
  const card: import('../shared/robot/system/card.ts').SystemCard
  export default card
}

/** Tests only: the browser's build refuses this module (scripts/system-cards-plugin.ts) */
declare module 'virtual:system-card-tku' {
  const card: string
  export default card
}
