import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import styled from 'styled-components'
import { clubLogoUrl, LOGO_MAX_BYTES, LOGO_PIXELS, type ClubLogoRef } from '../../shared/club-logo.ts'
import { api, ApiError } from '../lib/api.ts'
import { AVATAR_INPUT_TYPES, isLogoInput } from '../lib/avatarImage.ts'
import { currentClub } from '../lib/club.ts'
import { useClubName } from '../lib/useClubName.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { ImageCropper } from './AvatarCropper.tsx'
import { ClubMark } from './Logo.tsx'
import { useToast } from './Toast.tsx'
import { Button, FieldHint, Muted } from './ui.tsx'

/**
 * 社團 Logo (AC-12.2): the club's admins pick a picture, crop it to a square in the browser
 * (`ImageCropper`, transparency kept) and upload it, or go back to the club's letter. The server
 * checks the admin and the file (`worker/logos.ts`); 淡江 keeps its lantern, so its admin page has
 * no such section.
 */

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${({ theme }) => theme.space(3)};
`

const Buttons = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

/** The cropper set for a logo: a 512×512 square, no circle, transparency kept */
export function LogoCropper({ file, onClose, onCropped }: { file: File; onClose: () => void; onCropped: (picture: Blob) => Promise<void> }) {
  const { t } = usePreferences()
  return (
    <ImageCropper
      file={file}
      onClose={onClose}
      title={t.logo.cropTitle}
      hint={t.logo.cropHint}
      frameLabel={t.logo.frame}
      pixels={LOGO_PIXELS}
      maxBytes={LOGO_MAX_BYTES}
      tooLarge="logoTooLarge"
      transparent
      onCropped={onCropped}
    />
  )
}

export function AdminLogo() {
  const { t, message } = usePreferences()
  const toast = useToast()
  const club = currentClub()
  const name = useClubName()
  const input = useRef<HTMLInputElement>(null)
  const [logo, setLogo] = useState<ClubLogoRef | null | undefined>(undefined)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const failed = (e: unknown) => (e instanceof ApiError && e.code ? message(e.code, e.params, e.message) : t.genericError)

  useEffect(() => {
    let live = true
    api.admin.logo().then(
      (found) => live && setLogo(found.logo),
      () => live && setLogo(null),
    )
    return () => {
      live = false
    }
  }, [])

  const choose = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (!picked) return
    if (!isLogoInput(picked)) return toast.error(message('logoBadFormat', {}, ''))
    setFile(picked)
  }

  const upload = async (picture: Blob) => {
    setLogo((await api.admin.setLogo(picture)).logo)
    setFile(null)
    toast.success(t.logo.saved)
  }

  const remove = async () => {
    setBusy(true)
    try {
      setLogo((await api.admin.clearLogo()).logo)
      toast.success(t.logo.removed)
    } catch (e) {
      toast.error(failed(e))
    } finally {
      setBusy(false)
    }
  }

  if (logo === undefined) return <Muted>{t.loading}</Muted>
  return (
    <>
      <Row>
        <ClubMark name={name} logo={logo ? clubLogoUrl(club, logo.version) : null} size={96} />
        <Buttons>
          <Button type="button" $size="sm" onClick={() => input.current?.click()}>
            {logo ? t.logo.change : t.logo.upload}
          </Button>
          {logo && (
            <Button type="button" $size="sm" $variant="ghost" $busy={busy} disabled={busy} onClick={() => void remove()}>
              {t.logo.remove}
            </Button>
          )}
          <input ref={input} type="file" accept={AVATAR_INPUT_TYPES.join(',')} hidden aria-label={t.logo.upload} onChange={choose} />
        </Buttons>
      </Row>
      {!logo && <FieldHint>{t.logo.none}</FieldHint>}
      {file && <LogoCropper file={file} onClose={() => setFile(null)} onCropped={upload} />}
    </>
  )
}
