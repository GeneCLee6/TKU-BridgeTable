import styled from 'styled-components'

/** Pieces the team match pages share (§5.8) */

/** A small label: the match's state (open ones stand out), or 「邀請你」 in the accent colour */
export const Tag = styled.span<{ $open: boolean; $accent?: boolean }>`
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme, $open, $accent }) =>
    $accent ? theme.colors.accentSoft : $open ? theme.colors.primarySoft : theme.colors.surfaceAlt};
  color: ${({ theme, $open, $accent }) =>
    $accent ? theme.colors.accentStrong : $open ? theme.colors.primaryStrong : theme.colors.textMuted};
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
`
