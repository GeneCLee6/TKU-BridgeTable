import { Copy, Link2, Link2Off } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import styled from 'styled-components'
import type { BoardShare } from '../../shared/protocol.ts'
import { api, ApiError } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { panelScroll } from '../styles/controls.ts'
import { Backdrop } from './Modal.tsx'
import { Button, Card, ErrorText, Input, Muted } from './ui.tsx'
import { appPath } from '../lib/club.ts'

/**
 * 公開分享連結 (e4-t38, ARCHITECTURE.md §4): a board's players and the admins make a link anyone
 * can open without signing in (`/share/<token>`, `SharedBoardPage`), copy it, or take it back.
 * The server decides who may and what the link shows; this only asks it
 */

const Panel = styled(Card)`
  width: 100%;
  max-width: 520px;
  ${panelScroll}
  color: ${({ theme }) => theme.colors.text};

  & > h2 {
    margin: 0 0 12px;
    font-size: 20px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Row = styled.div`
  display: flex;
  gap: 8px;
  margin: 12px 0 4px;

  & > input {
    flex: 1;
    min-width: 0;
  }
`

const Buttons = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
`

/** The address a share opens on this site */
// The link opens in the board's club (e12-t04): another club's under /c/<id>/
const shareUrl = (token: string) => `${window.location.origin}${appPath(`/share/${token}`)}`

export function BoardShareDialog({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const { t, lang, message } = usePreferences()
  const s = t.recordExport
  const titleId = useId()
  const [share, setShare] = useState<BoardShare | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [revoked, setRevoked] = useState(false)

  const fail = (e: unknown) => setError(errorText(e))
  const { genericError } = t
  const errorText = useCallback(
    (e: unknown) => (e instanceof ApiError ? message(e.code, e.params, e.message) : genericError),
    [message, genericError],
  )

  useEffect(() => {
    let live = true
    api
      .boardShare(boardId)
      .then((r) => live && setShare(r.share))
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [boardId, errorText])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const create = () =>
    run(async () => {
      setShare((await api.createBoardShare(boardId)).share)
      setRevoked(false)
    })
  const revoke = () =>
    run(async () => {
      await api.revokeBoardShare(boardId)
      setShare(null)
      setRevoked(true)
    })
  const copy = async () => {
    if (!share) return
    try {
      await navigator.clipboard.writeText(shareUrl(share.token))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked: the address is in the box to copy by hand
    }
  }

  return (
    <Backdrop onClick={(event) => event.target === event.currentTarget && onClose()}>
      <Panel role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{s.shareTitle}</h2>
        <Muted>{s.shareIntro}</Muted>
        {share && (
          <>
            <Row>
              <Input readOnly value={shareUrl(share.token)} aria-label={s.shareTitle} onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" onClick={copy}>
                <Copy size={16} aria-hidden />
                {copied ? s.shareCopied : s.shareCopy}
              </Button>
            </Row>
            <Muted>{s.shareMadeBy(share.createdBy.username, formatDateTime(share.createdAt, lang))}</Muted>
          </>
        )}
        {revoked && <Muted role="status">{s.shareRevoked}</Muted>}
        {share === undefined && !error && <Muted>{t.loading}</Muted>}
        {error && <ErrorText role="alert">{error}</ErrorText>}
        <Buttons>
          <Button type="button" onClick={onClose}>
            {t.close}
          </Button>
          {share && (
            <Button type="button" $variant="danger" disabled={busy} onClick={revoke}>
              <Link2Off size={16} aria-hidden />
              {s.shareRevoke}
            </Button>
          )}
          {share === null && (
            <Button type="button" $variant="primary" disabled={busy} onClick={create}>
              <Link2 size={16} aria-hidden />
              {s.shareCreate}
            </Button>
          )}
        </Buttons>
      </Panel>
    </Backdrop>
  )
}
