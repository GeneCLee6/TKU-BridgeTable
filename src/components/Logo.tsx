/**
 * The lantern mark (public/logo-mark.svg) inline, so its navy parts follow the theme through
 * currentColor. The lantern body, red suits and gold tassel stay fixed in both themes.
 */
export function LogoMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden focusable="false">
      <path d="M32 2.5v6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="M10 14.5c5.5 0 9-2.2 11-6.5h22c2 4.3 5.5 6.5 11 6.5l-4.5 4H14.5z" fill="currentColor" />
      <path
        d="M17 18.5h30c7.5 6.5 7.5 21.5 0 28H17c-7.5-6.5-7.5-21.5 0-28z"
        fill="#f2b84b"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path
        d="M24.5 19c-3 8-3 19 0 27M39.5 19c3 8 3 19 0 27"
        fill="none"
        stroke="#b8321f"
        strokeWidth="1.4"
        strokeOpacity=".55"
      />
      <path
        d="M32 22.5c-4 5-10 8-10 13 0 3.2 2.6 5.3 5.4 5.3 1.6 0 2.9-.6 3.6-1.5L29.5 43.5h5L33 39.3c.7.9 2 1.5 3.6 1.5 2.8 0 5.4-2.1 5.4-5.3 0-5-6-8-10-13z"
        fill="#0f3d7a"
      />
      <path d="M19 46.5h26l-3 4.5H22z" fill="currentColor" />
      <path d="M21 51v3.5M43 51v3.5" stroke="#d9a330" strokeWidth="1.6" />
      <path d="M21 61l-3.1-3.2a1.9 1.9 0 0 1 3.1-2.3 1.9 1.9 0 0 1 3.1 2.3z" fill="#e0263f" />
      <path d="M32 51v3.5" stroke="#b8321f" strokeWidth="2" />
      <path d="M32 54.5l3.2 4.25-3.2 4.25-3.2-4.25z" fill="#e0263f" />
      <g fill="currentColor">
        <circle cx="43" cy="56" r="1.7" />
        <circle cx="41.3" cy="58.6" r="1.7" />
        <circle cx="44.7" cy="58.6" r="1.7" />
        <path d="M42.4 58.5h1.2l.7 3.5h-2.6z" />
      </g>
    </svg>
  )
}
