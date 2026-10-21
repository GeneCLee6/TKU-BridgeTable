import styled, { css } from 'styled-components'

/** Shared building blocks for the chrome (lobby, history, forms) */

export const Button = styled.button<{ $variant?: 'primary' | 'ghost' | 'danger'; $small?: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: ${({ $small }) => ($small ? '32px' : '40px')};
  padding: 0 ${({ $small }) => ($small ? '12px' : '16px')};
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ $small }) => ($small ? '14px' : '15px')};
  font-weight: 600;
  white-space: nowrap;
  text-decoration: none;

  ${({ $variant, theme }) =>
    $variant === 'primary' &&
    css`
      background: ${theme.colors.primary};
      border-color: ${theme.colors.primary};
      color: ${theme.colors.onPrimary};
    `}
  ${({ $variant, theme }) =>
    $variant === 'ghost' &&
    css`
      background: transparent;
      border-color: transparent;
      color: ${theme.colors.primary};
    `}
  ${({ $variant, theme }) =>
    $variant === 'danger' &&
    css`
      background: ${theme.colors.dangerSoft};
      border-color: ${theme.colors.danger};
      color: ${theme.colors.danger};
    `}

  &:disabled { opacity: 0.55; }
`

export const Card = styled.section`
  padding: ${({ theme }) => theme.space(4)};
  border-radius: ${({ theme }) => theme.radius.lg};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surface};
  box-shadow: ${({ theme }) => theme.shadow};
`

export const PageMain = styled.main`
  width: 100%;
  max-width: ${({ theme }) => theme.layout.contentMax};
  margin: 0 auto;
  padding: ${({ theme }) => theme.space(6)} 16px ${({ theme }) => theme.space(12)};
`

export const PageTitle = styled.h1`
  margin: 0 0 ${({ theme }) => theme.space(4)};
  font-size: 24px;
  line-height: 1.3;
  color: ${({ theme }) => theme.colors.primaryStrong};
`

export const Muted = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
`

export const ErrorText = styled.p`
  margin: 0;
  padding: 8px 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.dangerSoft};
  color: ${({ theme }) => theme.colors.danger};
  font-size: 14px;
`
