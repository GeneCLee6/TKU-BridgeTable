import { Download, Share2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import styled, { useTheme } from 'styled-components'
import type { ChallengeView } from '../../shared/challenge.ts'
import { challengeTitle } from '../lib/challenges.ts'
import { formatDateTime } from '../lib/format.ts'
import { drawShareCard, SHARE_CARD_SIZE, shareCardText, type ShareCardData } from '../lib/shareCard.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button, Card, Muted } from './ui.tsx'

/**
 * 成績分享卡 (`e7-t24`): the member's place, total and best board of a challenge as a picture,
 * drawn in the browser (`drawShareCard`), to download or hand to the phone's share sheet.
 */

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: ${({ theme }) => theme.colors.overlay};
`

const Panel = styled(Card)`
  width: 100%;
  max-width: 640px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  color: ${({ theme }) => theme.colors.text};

  & > h2 {
    margin: 0 0 12px;
    font-size: 20px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Picture = styled.canvas`
  display: block;
  width: 100%;
  height: auto;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
`

const Buttons = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
`

export function ShareCardDialog({ challenge, data, onClose }: { challenge: ChallengeView; data: ShareCardData; onClose: () => void }) {
  const { t, lang } = usePreferences()
  const theme = useTheme()
  const titleId = useId()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const title = challengeTitle(t, challenge)

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    const { colors } = theme
    drawShareCard(
      ctx,
      shareCardText(data, {
        site: `${t.appNameZh} · ${t.appNameEn}`,
        title,
        rank: t.shareCardRank,
        of: t.shareCardOf,
        totalLabel: `${t.totalCol} · ${t.scorings[data.scoring]}`,
        bestLabel: t.shareCardBest,
        bestLine: t.shareCardBestLine,
        footer: formatDateTime(challenge.endedAt ?? challenge.deadline, lang),
      }),
      { background: colors.header, text: colors.onHeader, muted: colors.headerMuted, accent: colors.accent, rule: colors.accent },
    )
    canvas.current?.toBlob((blob) => {
      if (blob) setFile(new File([blob], `tku-challenge-${challenge.id}.png`, { type: 'image/png' }))
    }, 'image/png')
  }, [challenge, data, lang, t, theme, title])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const download = () => {
    if (!file) return
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const canShare = !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
  const share = () => {
    if (!file) return
    // Closing the share sheet rejects; there is nothing to report
    navigator.share({ files: [file], title, text: t.shareCardText(title, data.rank, data.of) }).catch(() => {})
  }

  return (
    <Backdrop onClick={(event) => event.target === event.currentTarget && onClose()}>
      <Panel role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{t.shareCard}</h2>
        <Picture
          ref={canvas}
          width={SHARE_CARD_SIZE.width}
          height={SHARE_CARD_SIZE.height}
          role="img"
          aria-label={t.shareCardText(title, data.rank, data.of)}
        />
        {!data.final && <Muted>{t.standingsLive}</Muted>}
        <Buttons>
          <Button type="button" onClick={onClose}>
            {t.close}
          </Button>
          {canShare && (
            <Button type="button" onClick={share}>
              <Share2 size={16} aria-hidden />
              {t.shareCardShare}
            </Button>
          )}
          <Button type="button" $variant="primary" disabled={!file} onClick={download}>
            <Download size={16} aria-hidden />
            {t.shareCardDownload}
          </Button>
        </Buttons>
      </Panel>
    </Backdrop>
  )
}
