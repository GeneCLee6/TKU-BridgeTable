import qrcode from 'qrcode-generator'
import { useMemo } from 'react'
import styled, { useTheme } from 'styled-components'

/**
 * A QR code drawn as SVG in the page (the two-step sign-in setup, e11-t31). Encoded here with
 * `qrcode-generator` (MIT, no dependencies, bundled by Vite): nothing is fetched from elsewhere,
 * which the CSP would block anyway (docs/SECURITY.md §2), and the secret it carries never leaves the page
 */

/** Light modules around the code, as the QR standard asks */
const QUIET = 4

const Svg = styled.svg`
  display: block;
  width: 100%;
  max-width: 200px;
  height: auto;
  border-radius: ${({ theme }) => theme.radius.sm};
`

/** The dark modules as one path: a 1×1 square for each */
function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const size = qr.getModuleCount()
  let d = ''
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++) if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`
  return { size, d }
}

export function QrCode({ text, label }: { text: string; label: string }) {
  const theme = useTheme()
  const { size, d } = useMemo(() => qrPath(text), [text])
  const full = size + QUIET * 2
  return (
    <Svg role="img" aria-label={label} viewBox={`${-QUIET} ${-QUIET} ${full} ${full}`} shapeRendering="crispEdges">
      <rect x={-QUIET} y={-QUIET} width={full} height={full} fill={theme.qr.light} />
      <path d={d} fill={theme.qr.dark} />
    </Svg>
  )
}
