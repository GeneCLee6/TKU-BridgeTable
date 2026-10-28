import { createGlobalStyle } from 'styled-components'

export const GlobalStyle = createGlobalStyle`
  *, *::before, *::after { box-sizing: border-box; }

  html { color-scheme: ${({ theme }) => theme.mode}; }

  body {
    margin: 0;
    background: ${({ theme }) => theme.colors.bg};
    color: ${({ theme }) => theme.colors.text};
    font-family: ${({ theme }) => theme.fonts.body};
    font-size: 16px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    /* viewport-fit=cover (for the phone dock's room above the home bar): keep clear of a notch held sideways */
    padding-left: env(safe-area-inset-left, 0px);
    padding-right: env(safe-area-inset-right, 0px);
  }

  /* The CJK body font draws ’ “ ” full width (「club’ s」): in English and Vietnamese they come from a
     Latin font */
  @font-face {
    font-family: 'Latin Quotes';
    src: local('Segoe UI'), local('Helvetica Neue'), local('Roboto'), local('Arial');
    unicode-range: U+2018-201F;
  }
  html:lang(en) body,
  html:lang(vi) body {
    font-family: 'Latin Quotes', ${({ theme }) => theme.fonts.body};
  }

  a { color: ${({ theme }) => theme.colors.primary}; }

  :focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.focus};
    outline-offset: 2px;
    border-radius: 4px;
  }

  button, input, textarea, select { font: inherit; color: inherit; }
  /* A password field looks like any other: no spaced-out or enlarged dots. The CJK body font draws
     the browser's mask dot full width, so the dots of a password come from a Latin font */
  input { letter-spacing: normal; }
  input[type='password'] { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; }
  button { cursor: pointer; }
  button:disabled { cursor: default; }

  .visually-hidden {
    position: absolute !important;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0);
    white-space: nowrap; border: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition: none !important; animation: none !important; }
  }
`
