import 'styled-components'
import type { AppTheme } from './tokens.ts'

declare module 'styled-components' {
  // oxlint-disable-next-line typescript/no-empty-object-type
  export interface DefaultTheme extends AppTheme {}
}
