import { ImagePlus } from 'lucide-react'
import { useRef, useState } from 'react'
import { FILE_LIMITS, type UploadedFile } from '../../shared/files.ts'
import { ApiError } from '../lib/api.ts'
import { POST_IMAGE_TYPES, PostImageProblem, uploadPostImage } from '../lib/postImage.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button } from './ui.tsx'

/**
 * 加圖片 in the post editor (e13-t13): picks a picture, shrinks it in the browser and uploads it
 * (`src/lib/postImage.ts`); the editor adds an `image` piece with its key. What went wrong is
 * handed to `onError` in the reader's language (an empty string clears it).
 */
export function PostImageButton({
  disabled,
  onUploaded,
  onError,
}: {
  disabled?: boolean
  onUploaded: (file: UploadedFile) => void
  onError: (message: string) => void
}) {
  const { t, message } = usePreferences()
  const e = t.forumEditor
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    onError('')
    try {
      onUploaded(await uploadPostImage(file))
    } catch (err) {
      if (err instanceof PostImageProblem)
        onError(err.reason === 'badType' ? e.imageBadType : err.reason === 'tooLarge' ? e.imageTooLarge(FILE_LIMITS.maxBytes / 1024 / 1024) : e.imageUnreadable)
      else if (err instanceof ApiError) onError(message(err.code, err.params, err.message))
      else onError(e.imageUnreadable)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <>
      <Button type="button" $variant="secondary" $size="sm" $busy={busy} disabled={disabled || busy} onClick={() => input.current?.click()}>
        <ImagePlus size={14} aria-hidden />
        {busy ? e.imageUploading : e.addImage}
      </Button>
      <input
        ref={input}
        type="file"
        accept={POST_IMAGE_TYPES.join(',')}
        hidden
        aria-label={e.addImage}
        data-testid="post-image-input"
        onChange={(ev) => void pick(ev.target.files?.[0])}
      />
    </>
  )
}
