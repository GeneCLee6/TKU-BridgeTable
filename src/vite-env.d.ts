/// <reference types="vite/client" />

/** The system cards, worked out when the site is built (scripts/system-cards-plugin.ts) */
declare module 'virtual:system-cards' {
  const cards: import('../shared/robot/system/card.ts').SystemCards
  export default cards
}
